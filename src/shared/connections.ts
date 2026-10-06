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
  siwc?: {
    accounts: {
      key: string;
      label: string;
      signedIn: boolean;
      planEnabled: boolean;
    }[];
    selected?: string;
    busy: boolean;
    welcome: boolean;
    models: { slug: string; displayName: string }[];
  };
}
export const SIWC_ACTIONS = [
  "load",
  "connect",
  "select",
  "signout",
  "catalog",
  "acknowledge",
] as const;
export type SiwcAction = (typeof SIWC_ACTIONS)[number];
export function isConnectionChoice(value: unknown): value is ConnectionChoice {
  return CONNECTION_MODES.includes(value as ConnectionChoice);
}
