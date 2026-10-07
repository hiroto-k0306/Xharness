import { traceOperation } from "./trace.js";
import { imageMetadata } from "../../shared/images.js";
import { type ContentBlock } from "./types.js";
import { type ProviderEvent } from "../providers/provider.js";
import { messagesForProvider } from "./messages.js";
import { trimOutput } from "../tools/registry.js";
import { failure, structuredFailure } from "../tools/errors.js";
import {
  type LoopContext,
  type LoopOptions,
  type PendingCall,
  type Receipt,
  type Step,
  type StepName,
  type StepOutcome,
  toolCalls,
} from "./loop-types.js";

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
function countError(ctx: LoopContext, item: PendingCall) {
  if (item.counted) return;
  item.counted = true;
  ctx.consecutiveErrors = item.result?.isError ? ctx.consecutiveErrors + 1 : 0;
  if (item.result?.isError) {
    item.result.error ??= failure(item.errorKind ?? "failed");
    const errors = (ctx.toolFailures ??= new Map());
    const previous = errors.get(item.call.name);
    const kind = item.result.error.kind;
    const count = previous?.kind === kind ? previous.count + 1 : 1;
    errors.set(item.call.name, { kind, count });
    if (count >= 3 && kind !== "aborted" && !ctx.stopCause) {
      ctx.stopCause = "awaiting_user";
      ctx.failureQuestion = `${item.call.name}で同じ失敗（${kind}）が3回続いたため停止しました。${item.result.error.message} 環境・権限・入力を確認してから、どう進めるか入力してください。`;
    }
  } else ctx.toolFailures?.delete(item.call.name);
  if (ctx.consecutiveErrors >= 5) ctx.stopCause ??= "consecutive_errors";
}
export function appendResults(ctx: LoopContext, options: LoopOptions) {
  if (!ctx.pending.length || ctx.resultsAppended) return;
  const clean = options.redact ?? ((text: string) => text);
  const results: ContentBlock[] = ctx.pending.map((item, index) => {
    item.result ??= {
      content:
        ctx.stopCause === "aborted"
          ? "Interrupted by user"
          : (item.error ?? "Tool step failed"),
      isError: true,
      error: failure(
        ctx.stopCause === "aborted" ? "aborted" : (item.errorKind ?? "failed"),
      ),
    };
    countError(ctx, item);
    const injected =
      index === 0 && ctx.injections.length
        ? "\n" + ctx.injections.join("\n")
        : "";
    return {
      type: "tool_result",
      toolUseId: item.call.id,
      content:
        item.result.blocks?.length && !item.result.isError
          ? [
              { type: "text", text: clean(item.result.content + injected) },
              ...item.result.blocks,
            ]
          : (item.tool?.boundedOutput ? (text: string) => text : trimOutput)(
              clean(
                (item.result.error
                  ? JSON.stringify(item.result.error) + "\n"
                  : "") +
                  (item.result.error &&
                  item.result.content === JSON.stringify(item.result.error)
                    ? ""
                    : item.result.error &&
                        item.result.content.startsWith(
                          item.result.error.message,
                        )
                      ? item.result.content
                          .slice(item.result.error.message.length)
                          .trimStart()
                      : item.result.content) +
                  injected,
              ),
            ),
      isError: item.result.isError,
    };
  });
  ctx.messages.push({ role: "user", content: results });
  ctx.injections = [];
  ctx.resultsAppended = true;
}
export function nextAfterReceipt(
  ctx: LoopContext,
  options: LoopOptions,
): StepOutcome {
  if (ctx.stopCause) return { kind: "stop", reason: ctx.stopCause };
  if (
    ctx.completion?.stopReason === "max_tokens" &&
    !ctx.pending.length &&
    ctx.continuations < 2
  ) {
    if (ctx.round >= (options.maxRounds ?? 100))
      return { kind: "stop", reason: "round_limit" };
    ctx.continuations++;
    ctx.messages.push({
      role: "user",
      content: [{ type: "text", text: "Continue." }],
    });
    return { kind: "next", to: "context" };
  }
  if (!ctx.pending.length || ctx.completion?.stopReason !== "tool_use")
    return {
      kind: "stop",
      reason: ctx.completion?.stopReason ?? "incomplete_response",
    };
  return ctx.round >= (options.maxRounds ?? 100)
    ? { kind: "stop", reason: "round_limit" }
    : { kind: "next", to: "context" };
}
export function createSteps(options: LoopOptions): Record<StepName, Step> {
  return {
    context: {
      name: "context",
      async run(ctx, signal) {
        signal.throwIfAborted();
        const now = ctx.fallbackRoute ?? options.current?.() ?? ctx.route;
        ctx.route = {
          provider:
            ctx.fallbackRoute?.provider ??
            options.router?.provider(now?.model ?? options.model) ??
            options.provider,
          model: now?.model ?? options.model,
          reasoning: now ? now.reasoning : options.reasoning,
        };
        ctx.fallbackRoute = undefined;
        ctx.visitedModels.add(ctx.route.model);
        const prepared = await options.prepareContext?.(
          ctx.messages,
          ctx.route,
          signal,
          {
            system: options.system,
            tools: [...options.tools.values()].map((t) => t.spec),
          },
        );
        if (prepared?.stop) return { kind: "stop", reason: prepared.stop };
        ctx.contextView = prepared?.messages;
        ctx.contextLength = ctx.messages.length;
        ctx.request = {
          sessionId: options.sessionId,
          model: ctx.route.model,
          system: options.system,
          messages: messagesForProvider(
            ctx.contextView ?? ctx.messages,
            ctx.route.provider.id,
          ),
          tools: [...options.tools.values()].map((t) => t.spec),
          maxOutputTokens: options.maxOutputTokens,
          reasoning: ctx.route.reasoning,
        };
        return { kind: "next", to: "model" };
      },
    },
    model: {
      name: "model",
      async run(ctx, signal) {
        let failure: ProviderEvent | undefined;
        ctx.completion = undefined;
        if (!ctx.request) throw new Error("Missing request");
        // Hooks may append new information before this attempt; history stays intact.
        ctx.request = {
          ...ctx.request,
          messages: messagesForProvider(
            ctx.contextView
              ? [
                  ...ctx.contextView,
                  ...ctx.messages.slice(
                    ctx.contextLength ?? ctx.messages.length,
                  ),
                ]
              : ctx.messages,
            (ctx.route?.provider ?? options.provider).id,
          ),
        };
        for await (const event of (
          ctx.route?.provider ?? options.provider
        ).stream(ctx.request, signal)) {
          signal.throwIfAborted();
          options.onEvent?.(event);
          if (event.type === "message_done") ctx.completion = event;
          if (event.type === "error" || event.type === "rate_limited")
            failure = event;
        }
        if (failure || !ctx.completion) {
          ctx.completion = undefined;
          const delay =
            failure?.type === "rate_limited"
              ? failure.retryAfterSec === undefined ||
                failure.retryAfterSec > (options.retryWaitSec ?? 60)
                ? undefined
                : failure.retryAfterSec * 1000
              : failure?.type === "error" && failure.error.retryable
                ? 1000 * 2 ** ctx.modelAttempts
                : undefined;
          if (delay !== undefined && ctx.modelAttempts < 3) {
            ctx.modelAttempts++;
            return { kind: "retry", afterMs: delay };
          }
          if (failure?.type === "rate_limited") {
            // A 429 does not prove separate model pools. Never chase sibling
            // models in the same unknown/shared provider pool during this turn.
            ctx.limitedProviders.add(
              (ctx.route?.provider ?? options.provider).id,
            );
            const route = options.router?.fallback(
              (ctx.route?.provider ?? options.provider).id,
              ctx.request.reasoning?.effort,
              ctx.visitedModels,
              ctx.limitedProviders,
            );
            if (route) {
              await options.onFallback?.(route);
              ctx.fallbackRoute = route;
              ctx.modelAttempts = 0;
              const receipt: Receipt = {
                round: ctx.round,
                provider: (ctx.route?.provider ?? options.provider).id,
                model: ctx.request.model,
                decision: "fallback",
                detail: `Fallback to ${route.model}`,
                startedAt: ctx.startedAt,
                completedAt: new Date().toISOString(),
              };
              ctx.receipts.push(receipt);
              options.onEvent?.({ type: "receipt", receipt });
              return {
                kind: "fallback",
                to: "context",
                reason: "rate_limited",
              };
            }
            const detail =
              "429: 未訪問の独立provider fallback候補なし。共有・不明provider枠の別モデルは見送り。既存の安全な枠待ち・手動再確認へ停止。";
            const receipt: Receipt = {
              round: ctx.round,
              provider: (ctx.route?.provider ?? options.provider).id,
              model: ctx.request.model,
              decision: "error",
              detail,
              output: detail,
              startedAt: ctx.startedAt,
              completedAt: new Date().toISOString(),
            };
            ctx.receipts.push(receipt);
            options.onEvent?.({ type: "receipt", receipt });
          }
          return {
            kind: "stop",
            reason:
              failure?.type === "rate_limited"
                ? "rate_limited"
                : failure?.type === "error"
                  ? failure.error.kind
                  : "incomplete_response",
          };
        }
        const message = structuredClone(ctx.completion.message);
        const pending = toolCalls(message);
        if (new Set(pending.map((p) => p.call.id)).size !== pending.length)
          return { kind: "stop", reason: "protocol" };
        ctx.messages.push(message);
        ctx.pending = pending;
        return { kind: "next", to: pending.length ? "tool_use" : "receipt" };
      },
    },
    tool_use: {
      name: "tool_use",
      async run(ctx, signal) {
        for (const item of ctx.pending) {
          signal.throwIfAborted();
          item.tool = options.tools.get(item.call.name);
          const signature = item.call.name + canonical(item.call.input);
          ctx.repeated = signature === ctx.lastCall ? ctx.repeated + 1 : 1;
          ctx.lastCall = signature;
          try {
            item.error =
              ctx.repeated > 3
                ? "Repeated identical tool call; choose another approach"
                : !item.tool
                  ? "Unknown or unavailable tool"
                  : await item.tool.validate(item.call.input);
          } catch (error) {
            const detail = signal.aborted
              ? failure("aborted")
              : structuredFailure(error);
            item.error = detail.message;
            item.errorKind = detail.kind;
          }
          if (item.error) item.errorKind ??= "invalid_args";
        }
        return { kind: "next", to: "gate" };
      },
    },
    gate: {
      name: "gate",
      async run(ctx, signal) {
        const control = ctx.pending.find(
          (item) => item.tool?.control && !item.error,
        );
        if (control) {
          signal.throwIfAborted();
          control.allowed = true;
          return { kind: "next", to: "act" };
        }
        for (const item of ctx.pending) {
          if (item.error) continue;
          signal.throwIfAborted();
          item.allowed =
            item.tool?.autoAllow ||
            (await options.permission(item.call, signal));
          if (!item.allowed) {
            item.error =
              "操作は許可されませんでした。ユーザーの拒否、権限ルール、またはワークフロー段階の制限を確認してください。同じ操作を繰り返す前に、制限の原因を確認してください。";
            item.errorKind = "denied";
          }
        }
        return { kind: "next", to: "act" };
      },
    },
    act: {
      name: "act",
      async run(ctx, signal) {
        const execute = async (item: PendingCall) => {
          options.onEvent?.({
            type: "tool_progress",
            index: ctx.pending.indexOf(item) + 1,
            total: ctx.pending.length,
          });
          if (ctx.stopCause) {
            item.result = {
              content: "作業が停止したため、このツールは実行しませんでした。",
              isError: true,
            };
            return;
          }
          if (item.error)
            item.result = {
              content: item.error,
              isError: true,
              error: failure(item.errorKind ?? "invalid_args"),
            };
          else
            try {
              signal.throwIfAborted();
              if (!item.allowed || !item.tool)
                throw new Error("Missing permission");
              const invalid = await item.tool.validate(item.call.input);
              item.result = invalid
                ? {
                    content: invalid,
                    isError: true,
                    error: failure("invalid_args"),
                  }
                : await traceOperation(
                    "tool",
                    item.call.name,
                    item.call.input,
                    () =>
                      options.executeTool
                        ? options.executeTool(item.call, item.tool!, signal)
                        : item.tool!.execute(item.call.input, signal, {
                            redact: options.redact,
                            checkpoint: options.checkpoint,
                          }),
                    { callId: item.call.id },
                  );
              if (item.result.stop && !item.result.isError)
                ctx.stopCause = item.result.stop.reason;
            } catch (error) {
              const detail = signal.aborted
                ? failure("aborted")
                : structuredFailure(error);
              item.result = {
                content: detail.message,
                error: detail,
                isError: true,
              };
            }
          countError(ctx, item);
        };
        let batch: PendingCall[] = [];
        const control = ctx.pending.find(
          (item) => item.tool?.control && !item.error && item.allowed,
        );
        if (control) {
          await execute(control);
          // Always close sibling tool IDs without performing their side effects.
          for (const item of ctx.pending.filter((item) => item !== control)) {
            item.result = {
              content:
                "停止・質問の要求が優先されたため、このツールは実行しませんでした。",
              isError: true,
            };
          }
          return { kind: "next", to: "receipt" };
        }
        for (const item of ctx.pending) {
          if (item.tool?.readOnly) batch.push(item);
          else {
            await Promise.all(batch.map(execute));
            batch = [];
            await execute(item);
          }
        }
        await Promise.all(batch.map(execute));
        return { kind: "next", to: "receipt" };
      },
    },
    receipt: {
      name: "receipt",
      async run(ctx, signal) {
        if (signal.aborted) ctx.stopCause = "aborted";
        appendResults(ctx, options);
        const notice = ctx.pending.find((item) => item.result?.stop)?.result
          ?.stop;
        if ((notice || ctx.failureQuestion) && !ctx.recorded) {
          const text = (options.redact ?? ((s: string) => s))(
            notice?.message ?? ctx.failureQuestion!,
          );
          ctx.messages.push({
            role: "assistant",
            content: [{ type: "text", text }],
          });
          options.onEvent?.({ type: "text_delta", text });
        }
        if (!ctx.recorded) {
          const completedAt = new Date().toISOString();
          const entries: Receipt[] = [
            {
              round: ctx.round,
              provider: (ctx.route?.provider ?? options.provider).id,
              model: ctx.request?.model ?? options.model,
              decision: ctx.stopCause ?? ctx.completion?.stopReason ?? "failed",
              startedAt: ctx.startedAt,
              completedAt,
              usage: ctx.completion?.usage,
              input: ctx.request
                ? JSON.parse(
                    JSON.stringify(ctx.request, (_key, value) =>
                      imageMetadata(value),
                    ),
                  )
                : undefined,
              output: ctx.completion
                ? JSON.stringify(ctx.completion.message, (_key, value) =>
                    imageMetadata(value),
                  )
                : undefined,
            },
            ...ctx.pending.map((item) => ({
              round: ctx.round,
              provider: "tool",
              input: item.call.input,
              output: item.result?.content,
              error: item.result?.error,
              model: ctx.request?.model ?? options.model,
              tool: item.call.name,
              decision: item.result?.isError ? "error" : "allow",
              startedAt: ctx.startedAt,
              completedAt,
            })),
          ];
          ctx.receipts.push(...entries);
          ctx.recorded = true;
          for (const receipt of entries)
            options.onEvent?.({ type: "receipt", receipt });
        }
        return nextAfterReceipt(ctx, options);
      },
    },
  };
}
