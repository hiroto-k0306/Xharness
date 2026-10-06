export const CONNECTION_MODES = [
  "legacy",
  "openai-siwc",
  "claude-proposals",
  "claude-mcp",
] as const;
export type ConnectionChoice = (typeof CONNECTION_MODES)[number];
export interface ConnectionView {
  mode: ConnectionChoice;
  label: string;
  status: "unconfigured" | "available" | "needs_auth";
  reason: string;
}
export function isConnectionChoice(value: unknown): value is ConnectionChoice {
  return CONNECTION_MODES.includes(value as ConnectionChoice);
}
