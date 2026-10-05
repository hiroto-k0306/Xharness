import {
  type Message,
  type ProviderId,
  type ToolSpec,
  type Usage,
} from "../core/types.js";

export interface ModelInfo {
  id: string;
  contextTokens: number | null;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  reasoning?: { effort: ReasoningEffort };
  sessionId?: string;
  /** Only standalone WebSearch tool calls opt into a hosted search. */
  webSearch?: { mode: "live" | "cached" };
  compaction?: { type: "summarize" };
}

export interface QuotaUsage {
  windows: {
    name: string;
    usedPercent?: number;
    windowMinutes?: number;
    resetAt?: string;
  }[];
}

export interface ProviderError {
  kind: "authentication" | "request" | "transport" | "protocol" | "aborted";
  message: string;
  status?: number;
  retryable: boolean;
}

export type StopReason =
  "end_turn" | "tool_use" | "max_tokens" | "refusal" | "compaction" | "other";
export type ProviderEvent =
  | ({
      type: "auth_refresh";
      provider: ProviderId;
    } & import("../auth/auto-refresh.js").RefreshResult)
  | ({ type: "usage"; provider: ProviderId } & QuotaUsage)
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "message_done";
      message: Message;
      stopReason: StopReason;
      usage: Usage;
    }
  | { type: "rate_limited"; retryAfterSec?: number; scope?: string }
  | { type: "error"; error: ProviderError };

export interface Provider {
  readonly offline?: boolean;
  readonly id: ProviderId;
  models(): ModelInfo[];
  stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}
