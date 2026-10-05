export const LOCAL_FIXTURE_URL = "local-fixture:counter-v1";
export interface BrowserObservation {
  id: string;
  generation: number;
  tabId: string;
  documentId: string;
  url: typeof LOCAL_FIXTURE_URL;
  frameHash: string;
  imageHash: string;
  image: string;
  width: number;
  height: number;
  count: number;
  target: {
    id: "increment";
    label: string;
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
export interface BrowserOperation {
  id: string;
  observationId: string;
  generation: number;
  tabId: string;
  documentId: string;
  url: typeof LOCAL_FIXTURE_URL;
  frameHash: string;
  imageHash: string;
  target: BrowserObservation["target"];
  startedAt: number;
  finishedAt?: number;
  mode: "fake" | "electron_local";
  status: "pending" | "succeeded" | "cancelled" | "unknown";
  countAfter?: number;
}
export interface LocalBrowserView {
  phase:
    "stopped" | "observed" | "awaiting_confirmation" | "executing" | "unknown";
  available: boolean;
  mode?: BrowserOperation["mode"];
  observation?: BrowserObservation;
  confirmation?: { id: string; expiresAt: number };
  operations: BrowserOperation[];
  note: string;
}
export type LocalBrowserAction =
  | { action: "view" | "observe" | "stop" }
  | { action: "prepare"; observationId: string }
  | { action: "confirm"; confirmationId: string; confirmed: true };
export function parseLocalBrowserAction(
  v: unknown,
): LocalBrowserAction | undefined {
  if (!v || typeof v !== "object") return;
  const c = v as Record<string, unknown>,
    id = (s: unknown): s is string =>
      typeof s === "string" && /^[\w-]{1,128}$/.test(s);
  if (c.action === "view" || c.action === "observe" || c.action === "stop")
    return { action: c.action };
  if (c.action === "prepare" && id(c.observationId))
    return { action: "prepare", observationId: c.observationId };
  if (c.action === "confirm" && id(c.confirmationId) && c.confirmed === true)
    return {
      action: "confirm",
      confirmationId: c.confirmationId,
      confirmed: true,
    };
}
