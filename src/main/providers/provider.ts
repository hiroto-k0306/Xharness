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

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  reasoning?: { effort: "low" | "medium" | "high" };
}

export interface ProviderError {
  kind: "authentication" | "request" | "transport" | "protocol" | "aborted";
  message: string;
  status?: number;
  retryable: boolean;
}

export type StopReason =
  "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
export type ProviderEvent =
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
  readonly id: ProviderId;
  models(): ModelInfo[];
  stream(
    request: ProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<ProviderEvent>;
}
