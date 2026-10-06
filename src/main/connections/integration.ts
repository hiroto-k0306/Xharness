import { randomUUID } from "node:crypto";
import { runTurn, type LoopOptions, type Receipt } from "../core/loop.js";
import { acquireHomeWriter } from "../home-writer.js";
import { reserveLlmCall, flushLlmCalls } from "../core/llm-budget.js";
import {
  traceStream,
  captureTraceResponse,
  captureTraceUsage,
  traceOperation,
} from "../core/trace.js";
import { tokenMeasurement, normalizeTokens } from "../providers/token-usage.js";
import type {
  Provider,
  ProviderEvent,
  ProviderRequest,
} from "../providers/provider.js";
import type { Message, Usage } from "../core/types.js";
import { ToolGateway } from "./boundary.js";
import { FileIntentLedger } from "./ledger.js";
import {
  ClaudeMcpDelegation,
  ClaudeProposals,
  type SdkBinding,
} from "./claude.js";
import { SiwcInference, siwcReadiness, type SiwcBinding } from "./openai.js";
import {
  BoundaryError,
  type ConnectionMode,
  type Input,
  type Scope,
} from "./contracts.js";

export interface ConnectionSelection {
  mode: ConnectionMode;
  taskId: string;
  /** Only fixture bindings may mark themselves simulated. */
  simulated?: boolean;
  sdk?: SdkBinding;
  siwc?: SiwcBinding;
  timeoutMs?: number;
}
/** Already-owned home variant for controller/headless integration. No legacy provider fallback. */
export async function runConnectedTurnOwned(
  home: string,
  options: LoopOptions,
  selection: ConnectionSelection,
  signal: AbortSignal,
) {
  if (!options.sessionId) throw new BoundaryError("session-mismatch");
  const ledger = new FileIntentLedger(home, options.sessionId);
  const delegated: Message[] = [];
  const delegatedReceipts: Receipt[] = [];
  const provider: Provider = {
    id: selection.mode === "openai-siwc" ? "codex" : "claude",
    offline: !!selection.simulated,
    models: () => [{ id: options.model, contextTokens: null }],
    stream(request, abort) {
      return traceStream(
        `connection:${selection.mode}`,
        request,
        stream(request, abort),
        !!selection.simulated,
      );
    },
  };
  let round = 0;
  let toolTail: Promise<void> = Promise.resolve();
  async function* stream(
    request: ProviderRequest,
    abort: AbortSignal,
  ): AsyncIterable<ProviderEvent> {
    round++;
    if (request.webSearch || request.compaction)
      throw new BoundaryError("unsupported");
    if (
      request.messages.some((m) =>
        m.content.some(
          (b) => !["text", "tool_use", "tool_result"].includes(b.type),
        ),
      )
    )
      throw new BoundaryError("unsupported");
    const scope: Scope = {
      taskId: selection.taskId,
      sessionId: options.sessionId!,
      requestId: randomUUID(),
    };
    const input: Input = {
      ...scope,
      model: request.model,
      effort: request.reasoning?.effort,
      instructions:
        request.system +
        "\nX tool definitions: " +
        JSON.stringify(request.tools),
      history: request.messages.map((m) => ({
        role: m.role,
        content: JSON.stringify(m.content),
      })),
      tools: request.tools.map((t) => t.name),
      timeoutMs: selection.timeoutMs ?? 60_000,
    };
    try {
      await ledger.assertSettled();
    } catch {
      yield {
        type: "error",
        error: {
          kind: "protocol",
          message: "connection_uncertain",
          retryable: false,
        },
      };
      return;
    }
    const ready =
      selection.mode === "openai-siwc"
        ? siwcReadiness(selection.siwc).available
        : selection.sdk?.subscriptionUseConfirmed;
    if (!ready) {
      yield {
        type: "error",
        error: {
          kind: "authentication",
          message: "connection_unconfigured",
          retryable: false,
        },
      };
      return;
    }
    reserveLlmCall(abort, !!selection.simulated);
    await flushLlmCalls();
    captureTraceResponse({ requestDispatched: true });
    const xTools = Object.fromEntries(
      [...options.tools].map(([name, tool]) => [
        name,
        {
          validate: async (value: unknown) => !(await tool.validate(value)),
          execute: async (value: unknown, inner: AbortSignal) => {
            const result = await traceOperation("tool", name, value, () =>
              tool.execute(value, inner, {
                redact: options.redact,
                checkpoint: options.checkpoint,
              }),
            );
            if (result.isError || result.blocks?.length || result.stop)
              throw new BoundaryError("unsupported");
            return result.content;
          },
        },
      ]),
    );
    const gateway = new ToolGateway(
      scope,
      xTools,
      ledger,
      async (_scope, action) =>
        options.permission(
          { id: action.id, name: action.tool, input: action.input },
          abort,
        ),
      (action, content) => {
        const clean = options.redact ?? ((text) => text);
        delegated.push(
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: action.id,
                name: action.tool,
                input: action.input,
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                toolUseId: action.id,
                content: clean(content),
              },
            ],
          },
        );
        const receipt: Receipt = {
          round,
          provider: "tool",
          model: request.model,
          tool: action.tool,
          input: action.input,
          output: clean(content),
          decision: "allowed",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        delegatedReceipts.push(receipt);
        options.onEvent?.({ type: "receipt", receipt });
      },
    );
    const outcome =
      selection.mode === "claude-mcp"
        ? await new ClaudeMcpDelegation(selection.sdk, gateway).delegate(
            input,
            abort,
            () => {},
          )
        : selection.mode === "claude-proposals"
          ? await new ClaudeProposals(selection.sdk).infer(input, abort)
          : await new SiwcInference(selection.siwc).infer(input, abort);
    const measurement = tokenMeasurement(
      provider.id,
      outcome.measurement?.raw ?? {},
    );
    if (outcome.measurement) captureTraceUsage(measurement);
    const totals = normalizeTokens(measurement);
    captureTraceResponse({
      connectionMode: selection.mode,
      outcome: outcome.status,
      quota: outcome.quota,
      usageScope: outcome.measurement?.scope ?? "partial-or-unavailable",
    });
    const usage: Usage = {
      // Compatibility scalars sum measured values only. measurement carries missingness.
      inputTokens: totals.input ?? 0,
      outputTokens: totals.output ?? 0,
      measurement,
    };
    if (outcome.status !== "completed") {
      yield {
        type: "error",
        error: {
          kind: outcome.status === "cancelled" ? "aborted" : "protocol",
          message:
            outcome.status === "quota-paused"
              ? "connection_quota_paused"
              : `connection_${outcome.error ?? outcome.status}`,
          retryable: false,
        },
      };
      return;
    }
    const proposal = outcome.proposal!;
    if (proposal.answer) yield { type: "text_delta", text: proposal.answer };
    yield {
      type: "message_done",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: proposal.answer },
          ...proposal.actions.map((a) => ({
            type: "tool_use" as const,
            id: a.id,
            name: a.tool,
            input: a.input,
          })),
        ],
        meta: { provider: provider.id, model: request.model, usage },
      },
      usage,
      stopReason: proposal.actions.length ? "tool_use" : "end_turn",
    };
  }
  const result = await runTurn(
    {
      ...options,
      provider,
      router: undefined,
      current: undefined,
      executeTool: (call, tool, abort) => {
        const run = async () => {
          const scope = {
            taskId: selection.taskId,
            sessionId: options.sessionId!,
            requestId: "x-loop",
          };
          const action = { id: call.id, tool: call.name, input: call.input };
          if (!(await ledger.claim(scope, action)))
            return {
              content: "connection_uncertain",
              stop: {
                reason: "awaiting_user" as const,
                message:
                  "Inspect pending/duplicate operation before continuing",
              },
            };
          abort.throwIfAborted();
          const output = await tool.execute(call.input, abort, {
            redact: options.redact,
            checkpoint: options.checkpoint,
          });
          abort.throwIfAborted();
          if (!output.isError) await ledger.complete(scope, action);
          return output;
        };
        const pending = toolTail.then(run);
        toolTail = pending.then(
          () => {},
          () => {},
        );
        return pending;
      },
    },
    signal,
  );
  if (delegated.length)
    result.messages.splice(
      result.messages.length > options.messages.length
        ? result.messages.length - 1
        : result.messages.length,
      0,
      ...delegated,
    );
  result.receipts.push(...delegatedReceipts);
  return result;
}
/** Standalone development API. Existing controller should call Owned while its writer is held. */
export async function runConnectedTurn(
  home: string,
  options: LoopOptions,
  selection: ConnectionSelection,
  signal: AbortSignal,
) {
  const writer = await acquireHomeWriter(home);
  try {
    return await runConnectedTurnOwned(home, options, selection, signal);
  } finally {
    await writer.release();
  }
}
