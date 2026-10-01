import { hookSnapshot, type HookResult } from "../hooks/step-hooks.js";
import { createSteps } from "./loop-steps.js";
import {
  beginNextRound,
  createLoopContext,
  type LoopContext,
  type LoopOptions,
  type Receipt,
  type StepName,
  type StepOutcome,
} from "./loop-types.js";
export type {
  LoopOptions,
  LoopContext,
  Receipt,
  StepName,
  StepOutcome,
  Step,
  HookContext,
} from "./loop-types.js";
export { createLoopContext } from "./loop-types.js";
export { createSteps } from "./loop-steps.js";

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
export function transition(
  current: StepName,
  outcome: StepOutcome,
): StepName | undefined {
  switch (outcome.kind) {
    case "next":
    case "fallback":
      return outcome.to;
    case "retry":
      return current;
    case "stop":
      return undefined;
  }
}
function inject(ctx: LoopContext, options: LoopOptions, message: string) {
  const safe = (options.redact ?? ((text: string) => text))(message);
  if (ctx.pending.length && !ctx.resultsAppended) ctx.injections.push(safe);
  else
    ctx.messages.push({
      role: "user",
      content: [{ type: "text", text: safe }],
    });
}
async function runHook(
  timing: "before" | "after",
  step: StepName,
  ctx: LoopContext,
  options: LoopOptions,
  signal: AbortSignal,
): Promise<HookResult> {
  const hook = timing === "before" ? options.beforeStep : options.afterStep;
  if (!hook) return { kind: "continue" };
  const startedAt = new Date().toISOString();
  let result: HookResult;
  try {
    result = await hook(
      step,
      hookSnapshot({
        round: ctx.round,
        messages: ctx.messages,
        request: ctx.request,
        completion: ctx.completion,
        stopCause: ctx.stopCause,
      }),
      signal,
    );
    if (
      !result ||
      !["continue", "inject", "block", "stop"].includes(result.kind) ||
      (result.kind === "inject" && typeof result.message !== "string") ||
      ((result.kind === "block" || result.kind === "stop") &&
        (typeof result.reason !== "string" || !result.reason.trim())) ||
      (timing === "after" && result.kind === "block")
    )
      throw new Error("Invalid hook result");
  } catch {
    result = {
      kind: "stop",
      reason: signal.aborted ? "aborted" : "hook_failed",
    };
  }
  const clean = options.redact ?? ((text: string) => text);
  if (result.kind === "inject") inject(ctx, options, result.message);
  if (result.kind === "stop") ctx.stopCause = clean(result.reason);
  if (result.kind === "block") {
    if (ctx.pending.length && !ctx.resultsAppended && step !== "receipt") {
      for (const item of ctx.pending)
        if (!item.result) item.error = clean(result.reason);
    } else ctx.stopCause = clean(result.reason);
  }
  const receipt: Receipt = {
    round: ctx.round,
    provider: "hook",
    model: options.model,
    step,
    timing,
    decision: result.kind,
    detail:
      result.kind === "continue"
        ? undefined
        : clean(result.kind === "inject" ? result.message : result.reason),
    startedAt,
    completedAt: new Date().toISOString(),
  };
  ctx.receipts.push(receipt);
  options.onEvent?.({ type: "receipt", receipt });
  return result;
}

export async function runTurn(options: LoopOptions, signal: AbortSignal) {
  const ctx = createLoopContext(options);
  const steps = createSteps(options);
  let current: StepName = "context";
  while (true) {
    let outcome: StepOutcome;
    try {
      if (current !== "receipt") signal.throwIfAborted();
      options.onEvent?.({ type: "step", step: current, round: ctx.round });
      const before = await runHook("before", current, ctx, options, signal);
      if (
        current !== "receipt" &&
        (before.kind === "block" || before.kind === "stop")
      )
        outcome = { kind: "next", to: "receipt" };
      else {
        try {
          if (current !== "receipt") signal.throwIfAborted();
          outcome = await steps[current].run(ctx, signal);
        } catch {
          ctx.stopCause ??= signal.aborted ? "aborted" : "step_failed";
          if (current === "receipt") {
            try {
              await steps.receipt.run(ctx, signal);
            } catch {
              /* Already recorded before observer callbacks. */
            }
          }
          outcome = { kind: "stop", reason: ctx.stopCause };
        }
      }
      const after = await runHook("after", current, ctx, options, signal);
      if (ctx.stopCause)
        outcome =
          current === "receipt"
            ? { kind: "stop", reason: ctx.stopCause }
            : { kind: "next", to: "receipt" };
      else if (
        current === "receipt" &&
        after.kind === "inject" &&
        outcome.kind === "stop" &&
        outcome.reason === "end_turn"
      )
        outcome =
          ctx.round >= (options.maxRounds ?? 100)
            ? { kind: "stop", reason: "round_limit" }
            : { kind: "next", to: "context" };
    } catch {
      ctx.stopCause ??= signal.aborted ? "aborted" : "step_failed";
      // A failed receipt hook/observer must not leave tool IDs or the round open.
      if (current === "receipt") {
        try {
          await steps.receipt.run(ctx, signal);
        } catch {
          /* Entries are stored before observer callbacks. */
        }
        outcome = { kind: "stop", reason: ctx.stopCause };
      } else outcome = { kind: "next", to: "receipt" };
    }
    if (outcome.kind === "stop" && current !== "receipt") {
      ctx.stopCause = outcome.reason;
      current = "receipt";
      continue;
    }
    if (outcome.kind === "retry") {
      try {
        await (options.sleep ?? abortableDelay)(outcome.afterMs, signal);
      } catch {
        ctx.stopCause = signal.aborted ? "aborted" : "step_failed";
        current = "receipt";
        continue;
      }
    }
    const next = transition(current, outcome);
    if (!next) {
      ctx.stopCause = outcome.kind === "stop" ? outcome.reason : "step_failed";
      break;
    }
    if (current === "receipt" && next === "context") beginNextRound(ctx);
    current = next;
  }
  return {
    messages: ctx.messages,
    receipts: ctx.receipts,
    stopCause: ctx.stopCause ?? "round_limit",
  };
}
