/** Experimental boundaries. These are not installed application routing options. */
export type ConnectionMode = "openai-siwc" | "claude-proposals" | "claude-mcp";
export interface Scope {
  taskId: string;
  sessionId: string;
  requestId: string;
}
export interface Action {
  id: string;
  tool: string;
  input: unknown;
}
export interface Proposal {
  answer: string;
  actions: Action[];
}
export interface Input extends Scope {
  model: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  instructions: string;
  /** Complete X-owned context; never implicit provider session continuation. */
  history: { role: "user" | "assistant"; content: string }[];
  tools: string[];
  timeoutMs: number;
}
export interface Measurement {
  scope?: "responses-request" | "main-loop" | "query-pipeline";
  source: "responses" | "sdk-result";
  observedAt: string;
  /** Provider-native numbers only. null means absent, not zero. */
  raw: Record<string, unknown>;
  input: number | null;
  output: number | null;
}
export interface QuotaEvidence {
  source: "official-response" | "sdk-event";
  observedAt: string;
  usedPercent: number | null;
  resetAt: string | null;
  limited: boolean;
  native?: { utilization?: number; resetsAt?: number };
}
export interface Outcome extends Scope {
  mode: ConnectionMode;
  status: "completed" | "failed" | "cancelled" | "timeout" | "quota-paused";
  elapsedMs: number;
  proposal?: Proposal;
  measurement: Measurement | null;
  quota: QuotaEvidence | null;
  error?: FailureCode;
}
export type FailureCode =
  | "unconfigured"
  | "unsupported"
  | "malformed"
  | "session-mismatch"
  | "duplicate"
  | "uncertain"
  | "denied"
  | "transport"
  | "quota"
  | "cancelled"
  | "timeout";
export class BoundaryError extends Error {
  constructor(readonly code: FailureCode) {
    super(code);
  }
}
export interface ModelInference {
  readonly kind: "inference";
  infer(input: Input, signal: AbortSignal): Promise<Outcome>;
}
export interface AgentDelegation {
  readonly kind: "delegation";
  delegate(
    input: Input,
    signal: AbortSignal,
    progress: (phase: "started" | "tool" | "finished") => void,
  ): Promise<Outcome>;
}
export function validateProposal(value: unknown, tools: string[]): Proposal {
  if (!value || typeof value !== "object") throw new BoundaryError("malformed");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["answer", "actions"].includes(k)) ||
    typeof v.answer !== "string" ||
    !Array.isArray(v.actions) ||
    v.actions.length > 16
  )
    throw new BoundaryError("malformed");
  const ids = new Set<string>();
  const actions = v.actions.map((a: unknown) => {
    if (!a || typeof a !== "object") throw new BoundaryError("malformed");
    const x = a as Record<string, unknown>;
    if (
      Object.keys(x).some((k) => !["id", "tool", "input"].includes(k)) ||
      typeof x.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(x.id) ||
      typeof x.tool !== "string" ||
      !Object.hasOwn(x, "input")
    )
      throw new BoundaryError("malformed");
    if (!tools.includes(x.tool)) throw new BoundaryError("unsupported");
    if (ids.has(x.id)) throw new BoundaryError("duplicate");
    ids.add(x.id);
    return { id: x.id, tool: x.tool, input: x.input };
  });
  return { answer: v.answer, actions };
}
export const proposalSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "actions"],
  properties: {
    answer: { type: "string" },
    actions: {
      type: "array",
      maxItems: 16,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "tool", "input"],
        properties: {
          id: { type: "string" },
          tool: { type: "string" },
          input: { type: "object", additionalProperties: true },
        },
      },
    },
  },
};
