import { type Receipt } from "./ipc.js";

export interface ReplayFrame {
  position: number;
  recordedAt: string;
  receipt: Receipt;
}
export interface ReceiptReplay {
  version: 1;
  mode: "recorded";
  frames: ReplayFrame[];
  skipped: number;
}
const providers = ["claude", "codex", "harness", "hook"];
const kinds = [
  "model_call",
  "tool",
  "permission",
  "fallback",
  "compact",
  "hook",
];
const decisions = ["allow", "deny", "ask→allow", "ask→deny"];
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[\w-]+$/.test(v) && v.length <= 512;
const text = (v: unknown, max = 1000): v is string =>
  typeof v === "string" && v.length <= max;
const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

/** Immutable, bounded display snapshot. Contains no executors or network APIs. */
export function buildReceiptReplay(
  values: readonly unknown[],
  clean: (text: string) => string = (s) => s,
): ReceiptReplay {
  if (values.length > 10000) throw new Error("Too many replay receipts");
  const replay: ReceiptReplay = {
    version: 1,
    mode: "recorded",
    frames: [],
    skipped: 0,
  };
  let total = 0;
  values.forEach((value, position) => {
    let bytes: string;
    try {
      bytes = JSON.stringify(value, (key, v: unknown) =>
        typeof v === "string" &&
        /token|password|secret|authorization|account.?id/i.test(key)
          ? "[redacted]"
          : v,
      );
      if (typeof bytes !== "string") throw new Error();
    } catch {
      replay.skipped++;
      return;
    }
    if (bytes.length > 2_000_000 || (total += bytes.length) > 16_000_000)
      throw new Error("Replay receipts exceed size limit");
    const safe = clean(bytes)
      .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(
        /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "[redacted]",
      );
    let r: Receipt;
    try {
      r = JSON.parse(safe) as Receipt;
      if (
        !r ||
        typeof r !== "object" ||
        !text(r.id, 512) ||
        !r.id ||
        !id(r.sessionId) ||
        !providers.includes(r.provider) ||
        !kinds.includes(r.kind) ||
        !finite(r.ts) ||
        !Number.isFinite(new Date(r.ts).getTime()) ||
        !finite(r.durationMs) ||
        !text(r.summary, 64000) ||
        (r.agentId !== undefined && !id(r.agentId)) ||
        (r.model !== undefined && !text(r.model)) ||
        (r.tool !== undefined && !text(r.tool)) ||
        (r.output !== undefined && !text(r.output, 2_000_000)) ||
        (r.decision !== undefined && !decisions.includes(r.decision)) ||
        (r.usage !== undefined &&
          (!r.usage ||
            !finite(r.usage.inputTokens) ||
            !finite(r.usage.outputTokens)))
      )
        throw new Error();
    } catch {
      replay.skipped++;
      return;
    }
    // Copy only the public receipt contract; ignore unknown executable metadata.
    const receipt: Receipt = {
      id: r.id,
      sessionId: r.sessionId,
      ts: r.ts,
      provider: r.provider,
      kind: r.kind,
      durationMs: r.durationMs,
      summary: r.summary,
      ...(r.agentId !== undefined ? { agentId: r.agentId } : {}),
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.tool !== undefined ? { tool: r.tool } : {}),
      ...(r.decision !== undefined ? { decision: r.decision } : {}),
      ...(r.input !== undefined ? { input: r.input } : {}),
      ...(r.output !== undefined ? { output: r.output } : {}),
      ...(r.usage !== undefined
        ? {
            usage: {
              inputTokens: r.usage.inputTokens,
              outputTokens: r.usage.outputTokens,
            },
          }
        : {}),
    };
    replay.frames.push({
      position,
      recordedAt: new Date(r.ts).toISOString(),
      receipt,
    });
  });
  return replay;
}
