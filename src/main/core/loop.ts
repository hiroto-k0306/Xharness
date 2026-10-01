import { type ContentBlock, type Message, type Usage } from "./types.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "../providers/provider.js";
import {
  type Tool,
  type ToolCall,
  type ToolOutput,
  type ToolRegistry,
  trimOutput,
} from "../tools/registry.js";

export type StepName =
  "context" | "model" | "tool_use" | "gate" | "act" | "receipt";
export interface Receipt {
  round: number;
  provider: string;
  model: string;
  tool?: string;
  decision: string;
  startedAt: string;
  completedAt: string;
  usage?: Usage;
}
type Completion = Extract<ProviderEvent, { type: "message_done" }>;
interface PendingCall {
  call: ToolCall;
  tool?: Tool;
  error?: string;
  allowed?: boolean;
  result?: ToolOutput;
}
export interface LoopContext {
  round: number;
  messages: Message[];
  request?: ProviderRequest;
  completion?: Completion;
  stopCause?: string;
}
export interface LoopOptions {
  provider: Provider;
  model: string;
  system: string;
  messages: Message[];
  tools: ToolRegistry;
  permission(call: ToolCall, signal: AbortSignal): Promise<boolean>;
  beforeStep?(
    step: StepName,
    ctx: LoopContext,
    signal: AbortSignal,
  ): Promise<void>;
  afterStep?(
    step: StepName,
    ctx: LoopContext,
    signal: AbortSignal,
  ): Promise<void>;
  onEvent?(
    event:
      | ProviderEvent
      | { type: "step"; step: StepName; round: number }
      | { type: "receipt"; receipt: Receipt },
  ): void;
  maxRounds?: number;
  maxOutputTokens?: number;
  redact?(text: string): string;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}
export async function abortableDelay(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

export async function runTurn(options: LoopOptions, signal: AbortSignal) {
  const ctx: LoopContext = {
    round: 0,
    messages: structuredClone(options.messages),
  };
  const receipts: Receipt[] = [];
  const maxRounds = options.maxRounds ?? 100;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1)
    throw new Error("Invalid round limit");
  let lastCall = "";
  let repeated = 0;
  let consecutiveErrors = 0;
  let continuations = 0;
  const clean = options.redact ?? ((text: string) => text);
  const step = async (name: StepName, run: () => Promise<void>) => {
    signal.throwIfAborted();
    options.onEvent?.({ type: "step", step: name, round: ctx.round });
    await options.beforeStep?.(name, ctx, signal);
    signal.throwIfAborted();
    try {
      await run();
    } finally {
      await options.afterStep?.(name, ctx, signal);
    }
  };
  for (ctx.round = 1; ctx.round <= maxRounds; ctx.round++) {
    const startedAt = new Date().toISOString();
    ctx.completion = undefined;
    let pending: PendingCall[] = [];
    try {
      await step("context", async () => {
        ctx.request = {
          model: options.model,
          system: options.system,
          messages: ctx.messages,
          tools: [...options.tools.values()].map((t) => t.spec),
          maxOutputTokens: options.maxOutputTokens,
        };
      });
      await step("model", async () => {
        for (let attempt = 0; attempt <= 3; attempt++) {
          let failure: ProviderEvent | undefined;
          for await (const event of options.provider.stream(
            ctx.request!,
            signal,
          )) {
            signal.throwIfAborted();
            options.onEvent?.(event);
            if (event.type === "message_done") ctx.completion = event;
            if (event.type === "error" || event.type === "rate_limited")
              failure = event;
          }
          if (!failure && ctx.completion) break;
          ctx.completion = undefined;
          const delay =
            failure?.type === "rate_limited"
              ? failure.retryAfterSec === undefined ||
                failure.retryAfterSec > 30
                ? undefined
                : failure.retryAfterSec * 1000
              : failure?.type === "error" && failure.error.retryable
                ? 1000 * 2 ** attempt
                : undefined;
          if (delay === undefined || attempt === 3) {
            ctx.stopCause =
              failure?.type === "rate_limited"
                ? "rate_limited"
                : failure?.type === "error"
                  ? failure.error.kind
                  : "incomplete_response";
            return;
          }
          await (options.sleep ?? abortableDelay)(delay, signal);
        }
        if (ctx.completion) {
          const ids = ctx.completion.message.content
            .filter((b) => b.type === "tool_use")
            .map((b) => b.id);
          if (new Set(ids).size !== ids.length) {
            ctx.stopCause = "protocol";
            return;
          }
          ctx.messages.push(ctx.completion.message);
          pending = ctx.completion.message.content
            .filter(
              (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
                b.type === "tool_use",
            )
            .map((b) => ({ call: { id: b.id, name: b.name, input: b.input } }));
        }
      });
      if (pending.length) {
        await step("tool_use", async () => {
          const ids = new Set<string>();
          for (const item of pending) {
            item.tool = options.tools.get(item.call.name);
            const signature = item.call.name + canonical(item.call.input);
            repeated = signature === lastCall ? repeated + 1 : 1;
            lastCall = signature;
            item.error = ids.has(item.call.id)
              ? "Duplicate tool ID"
              : repeated > 3
                ? "Repeated identical tool call; choose another approach"
                : !item.tool
                  ? "Unknown or unavailable tool"
                  : await item.tool.validate(item.call.input);
            ids.add(item.call.id);
          }
        });
        await step("gate", async () => {
          for (const item of pending) {
            if (item.error) continue;
            signal.throwIfAborted();
            item.allowed = await options.permission(item.call, signal);
            if (!item.allowed) item.error = "Permission denied by user";
          }
        });
        await step("act", async () => {
          const execute = async (item: PendingCall) => {
            if (ctx.stopCause) {
              item.result = {
                content: "Stopped after consecutive errors",
                isError: true,
              };
              return;
            }
            if (item.error) {
              item.result = { content: item.error, isError: true };
            } else
              try {
                signal.throwIfAborted();
                const invalid = await item.tool!.validate(item.call.input);
                item.result = invalid
                  ? { content: invalid, isError: true }
                  : await item.tool!.execute(item.call.input, signal);
              } catch {
                item.result = {
                  content: signal.aborted
                    ? "Interrupted by user"
                    : "Tool execution failed",
                  isError: true,
                };
              }
            consecutiveErrors = item.result!.isError
              ? consecutiveErrors + 1
              : 0;
            if (consecutiveErrors >= 5) ctx.stopCause = "consecutive_errors";
          };
          // Read-only batches may run together; mutations preserve model order.
          let batch: PendingCall[] = [];
          for (const item of pending) {
            if (item.tool?.readOnly) batch.push(item);
            else {
              await Promise.all(batch.map(execute));
              batch = [];
              await execute(item);
            }
          }
          await Promise.all(batch.map(execute));
        });
      }
    } catch {
      ctx.stopCause ??= signal.aborted ? "aborted" : "step_failed";
    }
    // Even an interruption while waiting for permission must close every tool ID.
    if (pending.length) {
      const results: ContentBlock[] = pending.map((item) => {
        const result = item.result ?? {
          content:
            ctx.stopCause === "aborted"
              ? "Interrupted by user"
              : "Tool step failed",
          isError: true,
        };
        item.result = result;
        return {
          type: "tool_result",
          toolUseId: item.call.id,
          content: trimOutput(clean(result.content)),
          isError: result.isError,
        };
      });
      ctx.messages.push({ role: "user", content: results });
    }
    const record = async () => {
      const completedAt = new Date().toISOString();
      const entries: Receipt[] = [
        {
          round: ctx.round,
          provider: options.provider.id,
          model: options.model,
          decision: ctx.stopCause ?? ctx.completion?.stopReason ?? "failed",
          startedAt,
          completedAt,
          usage: ctx.completion?.usage,
        },
        ...pending.map((item) => ({
          round: ctx.round,
          provider: "tool",
          model: options.model,
          tool: item.call.name,
          decision: item.result?.isError ? "error" : "allow",
          startedAt,
          completedAt,
        })),
      ];
      for (const receipt of entries) {
        receipts.push(receipt);
        options.onEvent?.({ type: "receipt", receipt });
      }
    };
    // Receipt runs after cancellation too; the hooks receive the aborted signal.
    options.onEvent?.({ type: "step", step: "receipt", round: ctx.round });
    try {
      await options.beforeStep?.("receipt", ctx, signal);
    } catch {
      ctx.stopCause ??= "step_failed";
    }
    await record();
    try {
      await options.afterStep?.("receipt", ctx, signal);
    } catch {
      ctx.stopCause ??= "step_failed";
    }
    if (signal.aborted) ctx.stopCause = "aborted";
    if (consecutiveErrors >= 5) ctx.stopCause ??= "consecutive_errors";
    if (ctx.stopCause) break;
    const completion = ctx.completion as Completion | undefined;
    if (
      completion?.stopReason === "max_tokens" &&
      !pending.length &&
      continuations < 2
    ) {
      continuations++;
      ctx.messages.push({
        role: "user",
        content: [{ type: "text", text: "Continue." }],
      });
    } else if (!pending.length || completion?.stopReason !== "tool_use") {
      ctx.stopCause = completion?.stopReason ?? "incomplete_response";
      break;
    }
    if (ctx.round === maxRounds) ctx.stopCause = "round_limit";
  }
  return {
    messages: ctx.messages,
    receipts,
    stopCause: ctx.stopCause ?? "round_limit",
  };
}
