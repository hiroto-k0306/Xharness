import { type ToolSpec } from "../core/types.js";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}
export interface ToolOutput {
  content: string;
  isError?: boolean;
}
export interface Tool {
  spec: ToolSpec;
  readOnly: boolean;
  validate(input: unknown): Promise<string | undefined>;
  execute(input: unknown, signal: AbortSignal): Promise<ToolOutput>;
}
export type ToolRegistry = Map<string, Tool>;
export function trimOutput(text: string): string {
  return text.length > 30000
    ? text.slice(0, 14980) + "\n… output truncated …\n" + text.slice(-14980)
    : text;
}
