import {
  BoundaryError,
  proposalSchema,
  validateProposal,
  type AgentDelegation,
  type Input,
  type ModelInference,
  type Outcome,
  type Action,
  type FailureCode,
} from "./contracts.js";
import { RunBoundary, type ToolGateway } from "./boundary.js";
import { measureSdkResult } from "./measurement.js";
import { captureTraceResponse, captureTraceUsage } from "../core/trace.js";
import { tokenMeasurement } from "../providers/token-usage.js";

/** Narrow SDK port: concrete query/tool/createSdkMcpServer binding is not installed by this prototype. */
export interface SdkOptions {
  model: string;
  effort?: Input["effort"];
  systemPrompt: string;
  tools: [];
  settingSources: [];
  strictMcpConfig: true;
  mcpServers: Record<string, unknown>;
  allowedTools: string[];
  permissionMode: "dontAsk";
  persistSession: false;
  maxTurns: number;
  abortController: AbortController;
  outputFormat?: { type: "json_schema"; schema: typeof proposalSchema };
  canUseTool: (name: string) => Promise<{ behavior: "deny"; message: string }>;
  hooks: {
    PreToolUse: {
      hooks: ((input: { tool_name: string }) => Promise<unknown>)[];
    }[];
  };
}
export interface SdkBinding {
  subscriptionUseConfirmed: boolean;
  /** Must construct only the supplied handlers with official SDK tool()/createSdkMcpServer(). */
  createXServer(
    handlers: Record<string, (action: Action) => Promise<unknown>>,
  ): unknown;
  query(request: {
    prompt: string;
    options: SdkOptions;
  }): AsyncIterable<unknown>;
}
export function sdkReadiness(binding?: SdkBinding) {
  return binding?.subscriptionUseConfirmed
    ? { available: true, reason: null }
    : {
        available: false,
        reason:
          "SDK binding and subscription/distribution conditions are not confirmed",
      };
}
async function sdkRun(
  binding: SdkBinding | undefined,
  input: Input,
  signal: AbortSignal,
  gateway?: ToolGateway,
  progress: (phase: "started" | "tool" | "finished") => void = () => {},
) {
  if (!binding || !sdkReadiness(binding).available)
    throw new BoundaryError("unconfigured");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const names = gateway
    ? input.tools.map((name) => `mcp__xharness__${name}`)
    : [];
  const handlers: Record<string, (action: Action) => Promise<unknown>> = {};
  let toolFailure: FailureCode | undefined;
  const partialUsage = new Map<string, unknown>();
  for (const tool of gateway ? input.tools : []) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(tool))
      throw new BoundaryError("unsupported");
    handlers[tool] = async (action) => {
      try {
        if (action.tool !== tool) throw new BoundaryError("session-mismatch");
        const validated = validateProposal({ answer: "", actions: [action] }, [
          tool,
        ]).actions[0]!;
        progress("tool");
        const text = await gateway!.execute(
          {
            taskId: input.taskId,
            sessionId: input.sessionId,
            requestId: input.requestId,
          },
          validated,
          signal,
        );
        return { content: [{ type: "text", text }] };
      } catch (e) {
        toolFailure = e instanceof BoundaryError ? e.code : "transport";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: e instanceof BoundaryError ? e.code : "transport",
            },
          ],
        };
      }
    };
  }
  try {
    const options: SdkOptions = {
      model: input.model,
      effort: input.effort,
      systemPrompt:
        input.instructions +
        (!gateway
          ? "\nYou are the decision provider for XHarness. The listed X tools are executed by XHarness after its approval, not by this SDK. Propose their execution in the structured output actions array ({id,tool,input}); SDK built-in tools are intentionally disabled. Do not claim a listed X tool is unavailable merely because it is not an SDK tool. When X has returned tool results in history, use those results and emit actions=[] if done."
          : ""),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: gateway ? { xharness: binding.createXServer(handlers) } : {},
      allowedTools: names,
      permissionMode: "dontAsk",
      persistSession: false,
      maxTurns: gateway ? 8 : 4,
      abortController: controller,
      canUseTool: async () => ({
        behavior: "deny",
        message: "Only X-owned handlers may execute",
      }),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async ({ tool_name }) => ({
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  permissionDecision:
                    names.includes(tool_name) ||
                    (!gateway && tool_name === "StructuredOutput")
                      ? "allow"
                      : "deny",
                  permissionDecisionReason: "X tool boundary",
                },
              }),
            ],
          },
        ],
      },
      ...(!gateway
        ? {
            outputFormat: {
              type: "json_schema" as const,
              schema: proposalSchema,
            },
          }
        : {}),
    };
    progress("started");
    let sdkSession: unknown;
    for await (const raw of binding.query({
      prompt: JSON.stringify(input.history),
      options,
    })) {
      if (signal.aborted) throw new BoundaryError("cancelled");
      if (!raw || typeof raw !== "object") throw new BoundaryError("malformed");
      const event = raw as Record<string, unknown>;
      if (event.session_id !== undefined) {
        if (
          typeof event.session_id !== "string" ||
          (sdkSession !== undefined && sdkSession !== event.session_id)
        )
          throw new BoundaryError("session-mismatch");
        sdkSession = event.session_id;
      }
      if (event.type === "assistant") {
        const message = event.message as Record<string, unknown> | undefined;
        if (
          typeof message?.id === "string" &&
          message.usage &&
          typeof message.usage === "object" &&
          event.parent_tool_use_id == null
        ) {
          // SDK assistant output_tokens is a placeholder; only result totals are final.
          partialUsage.set(message.id, {
            ...message.usage,
            output_tokens: undefined,
          });
          captureTraceUsage(
            tokenMeasurement("claude", {
              iterations: [...partialUsage.values()],
            }),
          );
          captureTraceResponse({ usageScope: "partial-main-loop" });
        }
      }
      if (event.type === "rate_limit_event") {
        const info = event.rate_limit_info as
          Record<string, unknown> | undefined;
        if (
          info?.status === "rejected" ||
          info?.isUsingOverage === true ||
          info?.overageInUse === true ||
          info?.errorCode === "credits_required"
        )
          return {
            status: "quota-paused" as const,
            error: "quota" as const,
            measurement: null,
            quota: {
              source: "sdk-event" as const,
              observedAt: new Date().toISOString(),
              usedPercent: null,
              resetAt: null,
              limited: true,
              native: {
                ...(typeof info.utilization === "number" &&
                Number.isFinite(info.utilization)
                  ? { utilization: info.utilization }
                  : {}),
                ...(typeof info.resetsAt === "number" &&
                Number.isFinite(info.resetsAt)
                  ? { resetsAt: info.resetsAt }
                  : {}),
              },
            },
          };
      }
      // Never resume provider session IDs; only verify SDK consistency within this one query.
      if (event.type === "result") {
        const modelUsage =
          event.modelUsage && typeof event.modelUsage === "object"
            ? event.modelUsage
            : {};
        captureTraceResponse({
          observedModels: Object.keys(modelUsage).filter((model) =>
            /^[a-zA-Z0-9._:-]{1,200}$/.test(model),
          ),
        });
        progress("finished");
        if (gateway && toolFailure)
          return {
            status: "failed" as const,
            error: toolFailure,
            measurement: measureSdkResult(event),
          };
        if (event.subtype !== "success" || event.is_error === true)
          return {
            status: "failed" as const,
            error: "transport" as const,
            measurement: measureSdkResult(event),
          };
        try {
          if (gateway && typeof event.result !== "string")
            throw new BoundaryError("malformed");
          const proposal = gateway
            ? validateProposal(
                {
                  answer: typeof event.result === "string" ? event.result : "",
                  actions: [],
                },
                [],
              )
            : validateProposal(event.structured_output, input.tools);
          return {
            status: "completed" as const,
            proposal,
            measurement: measureSdkResult(event),
          };
        } catch (e) {
          return {
            status: "failed" as const,
            error: e instanceof BoundaryError ? e.code : ("malformed" as const),
            measurement: measureSdkResult(event),
          };
        }
      }
    }
    throw new BoundaryError("transport");
  } finally {
    controller.abort();
    signal.removeEventListener("abort", cancel);
  }
}
export class ClaudeProposals implements ModelInference {
  readonly kind = "inference";
  readonly boundary = new RunBoundary();
  constructor(private binding?: SdkBinding) {}
  infer(input: Input, signal: AbortSignal): Promise<Outcome> {
    input = structuredClone(input);
    return this.boundary.run("claude-proposals", input, signal, (inner) =>
      sdkRun(this.binding, input, inner),
    );
  }
}
export class ClaudeMcpDelegation implements AgentDelegation {
  readonly kind = "delegation";
  readonly boundary = new RunBoundary();
  constructor(
    private binding: SdkBinding | undefined,
    private gateway: ToolGateway,
  ) {}
  delegate(
    input: Input,
    signal: AbortSignal,
    progress: (phase: "started" | "tool" | "finished") => void,
  ): Promise<Outcome> {
    input = structuredClone(input);
    return this.boundary.run("claude-mcp", input, signal, (inner) =>
      sdkRun(this.binding, input, inner, this.gateway, progress),
    );
  }
}
