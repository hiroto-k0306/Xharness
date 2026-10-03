import { type ToolSpec } from "../core/types.js";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ToolOutput {
  error?: import("./errors.js").ToolFailure;
  stop?: { reason: "agent_stopped" | "awaiting_user"; message: string };
  content: string;
  isError?: boolean;
}
export interface WriteCheckpoint {
  beforeWrite(path: string): Promise<void>;
  afterWrite(path: string, bytes: Buffer): Promise<void>;
}
export interface Tool {
  invalidate?(): void;
  /** Output text is bounded by the tool before JSON serialization. */
  boundedOutput?: boolean;
  /** Release turn-owned resources even on stop/error. */
  endTurn?(): Promise<void>;
  /** Pure local display/history update with no external side effects. */
  autoAllow?: boolean;
  /** Local lifecycle operation: execute before any other call in the response. */
  control?: boolean;
  spec: ToolSpec;
  readOnly: boolean;
  validate(input: unknown): Promise<string | undefined>;
  execute(
    input: unknown,
    signal: AbortSignal,
    context?: {
      redact?: (text: string) => string;
      checkpoint?: WriteCheckpoint;
    },
  ): Promise<ToolOutput>;
}
export type ToolRegistry = Map<string, Tool>;
export function trimOutput(text: string): string {
  return text.length > 30000
    ? text.slice(0, 14980) + "\n… output truncated …\n" + text.slice(-14980)
    : text;
}
