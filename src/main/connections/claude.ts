import {
  BoundaryError,
  proposalSchema,
  validateProposal,
  type AgentDelegation,
  type Input,
  type ModelInference,
  type Outcome,
  type Action,
} from "./contracts.js";
import { RunBoundary, type ToolGateway } from "./boundary.js";
import { measure } from "./measurement.js";

/** Narrow SDK port: concrete query/tool/createSdkMcpServer binding is not installed by this prototype. */
export interface SdkOptions {
  model: string;
  systemPrompt: string;
  tools: [];
  settingsSources: [];
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
      systemPrompt: input.instructions,
      tools: [],
      settingsSources: [],
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
      // Never resume provider session IDs; only verify SDK consistency within this one query.
      if (event.type === "result") {
        if (event.subtype !== "success")
          return {
            status: "failed" as const,
            error: "transport" as const,
            measurement: measure("sdk-result", event.usage),
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
          progress("finished");
          return {
            status: "completed" as const,
            proposal,
            measurement: measure("sdk-result", event.usage),
          };
        } catch (e) {
          return {
            status: "failed" as const,
            error: e instanceof BoundaryError ? e.code : ("malformed" as const),
            measurement: measure("sdk-result", event.usage),
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
