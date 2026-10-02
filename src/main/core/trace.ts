import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface TraceRecord {
  id: string;
  sequence: number;
  phase: "start" | "end";
  kind: "step" | "llm" | "tool" | "delegation";
  agentId: string;
  parentSpan?: string;
  step?: string;
  round?: number;
  callId?: string;
  label: string;
  at: string;
  input?: unknown;
  output?: unknown;
  status?: string;
  simulated?: boolean;
}

/** Also used before persistence: credentials never enter the trace file. */
export function traceJson(value: unknown, clean: (s: string) => string) {
  return clean(
    JSON.stringify(value, (key, v: unknown) => {
      if (
        /^(authorization|chatgpt-account-id|account_?id|access_?token|refresh_?token|password|secret|signature|encrypted_content|opaque)$/i.test(
          key,
        )
      )
        return "[redacted]";
      if (typeof v !== "string") return v;
      try {
        const nested: unknown = JSON.parse(v);
        if (nested && typeof nested === "object")
          return traceJson(nested, clean);
      } catch {
        /* prose */
      }
      return clean(v);
    }) ?? "null",
  )
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted]",
    );
}

interface Writer {
  sequence: number;
  pending: Promise<void>;
  clean: (s: string) => string;
  write(record: TraceRecord): void;
}
interface Scope {
  writer: Writer;
  agentId: string;
  parentSpan?: string;
  step?: string;
  round?: number;
  callId?: string;
  capture?: (value: unknown) => void;
}
const scopes = new AsyncLocalStorage<Scope>();

export async function withSessionTrace<T>(
  home: string,
  id: string,
  clean: (s: string) => string,
  run: () => Promise<T>,
): Promise<T> {
  if (scopes.getStore()) return run();
  if (!/^[\w-]{1,512}$/.test(id)) throw new Error("Invalid trace session id");
  const path = join(home, "traces", `${id}.jsonl`);
  await mkdir(join(home, "traces"), { recursive: true });
  let sequence = 0;
  try {
    if ((await stat(path)).size > 32_000_000)
      throw new Error("Trace exceeds size limit");
    const saved = await readFile(path, "utf8");
    for (const line of saved.split("\n")) {
      try {
        const record = JSON.parse(line) as TraceRecord;
        if (Number.isSafeInteger(record.sequence))
          sequence = Math.max(sequence, record.sequence);
      } catch {
        /* interrupted last line */
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const writer: Writer = {
    sequence,
    clean,
    pending: Promise.resolve(),
    write(record) {
      let line = traceJson(record, clean);
      if (line.length > 1_000_000)
        line = traceJson(
          {
            ...record,
            input: "容量上限のため省略",
            output:
              record.kind === "llm" &&
              record.output &&
              typeof record.output === "object"
                ? {
                    dispatched:
                      "dispatched" in record.output && record.output.dispatched,
                    truncated: true,
                    body: "容量上限のため省略",
                  }
                : "容量上限のため省略",
          },
          clean,
        );
      writer.pending = writer.pending.then(() =>
        appendFile(path, line + "\n", "utf8"),
      );
      void writer.pending.catch(() => undefined);
    },
  };
  try {
    return await scopes.run({ writer, agentId: id }, run);
  } finally {
    await writer.pending;
  }
}

export function withTraceFields<T>(
  fields: Partial<Omit<Scope, "writer">>,
  run: () => T,
): T {
  const scope = scopes.getStore();
  return scope ? scopes.run({ ...scope, ...fields }, run) : run();
}

export function beginTrace(
  kind: TraceRecord["kind"],
  label: string,
  input?: unknown,
  simulated?: boolean,
) {
  const scope = scopes.getStore();
  if (!scope)
    return {
      fields: {},
      end: (...args: [unknown?, string?]) => {
        void args;
      },
    };
  const record: TraceRecord = {
    id: randomUUID(),
    sequence: ++scope.writer.sequence,
    phase: "start",
    kind,
    agentId: scope.agentId,
    parentSpan: scope.parentSpan,
    step: scope.step,
    round: scope.round,
    callId: scope.callId,
    label,
    input,
    simulated,
    at: new Date().toISOString(),
  };
  scope.writer.write(record);
  return {
    fields: { parentSpan: record.id },
    end(output?: unknown, status = "完了") {
      scope.writer.write({
        ...record,
        input: undefined,
        phase: "end",
        output,
        status,
        at: new Date().toISOString(),
      });
    },
  };
}

export async function traceOperation<T>(
  kind: TraceRecord["kind"],
  label: string,
  input: unknown,
  run: () => Promise<T>,
  fields: Partial<Omit<Scope, "writer">> = {},
): Promise<T> {
  const span = withTraceFields(
    fields.callId ? { callId: fields.callId } : {},
    () => beginTrace(kind, label, input),
  );
  return withTraceFields({ ...span.fields, ...fields }, async () => {
    try {
      const result = await run();
      span.end(
        result,
        result &&
          typeof result === "object" &&
          "isError" in result &&
          result.isError
          ? "エラー"
          : "完了",
      );
      return result;
    } catch (error) {
      span.end(undefined, "失敗・中断");
      throw error;
    }
  });
}

export function captureTraceResponse(value: unknown) {
  scopes.getStore()?.capture?.(value);
}

/** Bind every iterator.next(), so nested async generators retain the call scope. */
export async function* traceStream<T extends { type: string }>(
  label: string,
  input: unknown,
  stream: AsyncIterable<T>,
  simulated = false,
) {
  const scope = scopes.getStore();
  if (!scope) {
    yield* stream;
    return;
  }
  const span = beginTrace("llm", label, input, simulated);
  const raw: unknown[] = [];
  const decoded: T[] = [];
  let size = 0;
  let truncated = false;
  let body: unknown;
  let dispatched = false;
  let status = "応答未完了";
  const capture = (value: unknown) => {
    const safe = traceJson(value, scope.writer.clean);
    const parsed: unknown = JSON.parse(safe);
    const metadata =
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    if (typeof metadata.requestBody === "string") {
      body =
        safe.length <= 800_000
          ? JSON.parse(metadata.requestBody)
          : "容量上限のため省略";
      return;
    }
    if (metadata.requestDispatched === true) dispatched = true;
    if (size + safe.length > 800_000) {
      truncated = true;
      return;
    }
    size += safe.length;
    raw.push(JSON.parse(safe));
  };
  const iterator = stream[Symbol.asyncIterator]();
  const fields = { ...span.fields, capture };
  try {
    while (true) {
      const next = await withTraceFields(fields, () => iterator.next());
      if (next.done) break;
      const event = next.value;
      if (!["text_delta", "reasoning_delta"].includes(event.type))
        decoded.push(event);
      if (event.type === "message_done") status = "完了";
      if (event.type === "error") status = "エラー";
      if (event.type === "rate_limited") status = "利用制限";
      yield event;
    }
  } catch (error) {
    status = "失敗・中断";
    throw error;
  } finally {
    try {
      await withTraceFields(fields, () => iterator.return?.());
    } finally {
      span.end(
        { body, dispatched, events: decoded, response: raw, truncated },
        status,
      );
    }
  }
}
