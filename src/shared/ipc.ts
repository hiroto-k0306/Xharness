// main / preload / renderer が共有する契約。electron を import しない。
// DESIGN.md §16.4: チャネルは harness:event(main → renderer)と harness:command(renderer → main)の2本だけ。

export const EVENT_CHANNEL = "harness:event";
export const COMMAND_CHANNEL = "harness:command";

export type ProviderName = "claude" | "codex";
export type StepNumber = 1 | 2 | 3 | 4 | 5 | 6;
export const STEP_NODES = [
  "context",
  "model",
  "tool_use",
  "gate",
  "act",
  "receipt",
] as const;
export type StepNode = (typeof STEP_NODES)[number];

/** DESIGN.md §16.5 */
export interface Receipt {
  id: string;
  sessionId: string;
  ts: number;
  provider: ProviderName | "harness";
  model?: string;
  kind: "model_call" | "tool" | "permission" | "fallback" | "compact";
  tool?: string;
  decision?: "allow" | "deny" | "ask→allow" | "ask→deny";
  durationMs: number;
  usage?: { inputTokens: number; outputTokens: number };
  summary: string;
}

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_VALUES: readonly Effort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type SessionStatus = "idle" | "running" | "ask";

export interface SessionSummary {
  id: string;
  title: string;
  /** null = ワークスペース指定なし(「その他」§18.5) */
  workspaceId: string | null;
  cwd: string;
  readOnly: boolean;
  /** セッションごとのモデルと effort(§16.8)。set_model はこのセッションだけに効く */
  model: string;
  effort: Effort;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  providers: ProviderName[];
  branch?: string;
}

export interface WorkspaceSummary {
  id: string;
  root: string;
  name: string;
  kind: "git" | "no git" | "cloned";
  branch?: string;
  lastOpenedAt: number;
}

export interface AppState {
  sessions: SessionSummary[];
  workspaces: WorkspaceSummary[];
  currentSessionId: string | null;
  /** 新しいセッションの既定(--model > 設定ファイル > claude:opus / high) */
  model: string;
  effort: Effort;
  /** --fake で起動した(通信しない) */
  fake: boolean;
  version: string;
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      tool: string;
      summary: string;
      status: "pending" | "ok" | "error" | "denied";
    }
  | { kind: "notice"; id: string; tone: "dim" | "warn" | "err"; text: string };

/**
 * §16.4 の UiEvent。sessionId 付きのものは複数セッションの同時実行用の追加(§16.6)。
 * "state" / "transcript" / "user_message" / "turn" / "tool_result" / "permission_resolved" も追加分。
 */
export type UiEvent =
  | { type: "user_message"; sessionId: string; messageId: string; text: string }
  | {
      type: "step";
      sessionId: string;
      step: StepNumber;
      node: StepNode;
      round: number;
    }
  | { type: "text_delta"; sessionId: string; messageId: string; text: string }
  | {
      type: "tool_call";
      sessionId: string;
      receiptId: string;
      provider: string;
      tool: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      sessionId: string;
      receiptId: string;
      isError: boolean;
    }
  | {
      type: "permission_request";
      sessionId: string;
      requestId: string;
      /** どのツールカードの確認か(tool_call の receiptId) */
      receiptId?: string;
      tool: string;
      summary: string;
    }
  | {
      type: "permission_resolved";
      sessionId: string;
      requestId: string;
      decision: "allow" | "always" | "deny";
    }
  | { type: "receipt"; receipt: Receipt }
  | {
      type: "usage";
      provider: ProviderName;
      window5h?: number;
      weekly?: number;
    }
  | {
      type: "agent";
      agentId: string;
      name: string;
      model: string;
      status: "running" | "done" | "error";
    }
  | {
      type: "turn";
      sessionId: string;
      status: "running" | "idle";
      stopCause?: string;
    }
  | { type: "error"; sessionId?: string; message: string }
  | { type: "state"; state: AppState }
  | { type: "transcript"; sessionId: string; items: TranscriptItem[] };

export type PermissionDecision = "allow" | "always" | "deny";

export type HarnessCommand =
  | { type: "ready" }
  | { type: "send"; sessionId: string; text: string }
  | { type: "abort"; sessionId: string }
  | {
      type: "permission_response";
      sessionId: string;
      requestId: string;
      decision: PermissionDecision;
    }
  | { type: "set_model"; sessionId: string; model: string; effort?: Effort }
  | { type: "close_session"; sessionId: string }
  | { type: "new_session"; workspaceId: string | null; readOnly?: boolean }
  | { type: "open_session"; sessionId: string }
  | { type: "pick_folder" }
  | { type: "forget_workspace"; workspaceId: string };

export type CommandResult =
  | { ok: true; workspaceId?: string; sessionId?: string }
  | { ok: false; error: string };

/** preload が window.harness として公開する型付き API。これ以外は渡さない。 */
export interface HarnessApi {
  command(command: HarnessCommand): Promise<CommandResult>;
  onEvent(listener: (event: UiEvent) => void): () => void;
}

const MAX_TEXT = 200_000;
const str = (v: unknown, max = 512): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

/** 信頼できない入力(IPC)を検証する。不正なら undefined。 */
export function parseCommand(value: unknown): HarnessCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const c = value as Record<string, unknown>;
  switch (c.type) {
    case "ready":
    case "pick_folder":
      return { type: c.type };
    case "send":
      return str(c.sessionId) && str(c.text, MAX_TEXT)
        ? { type: "send", sessionId: c.sessionId, text: c.text }
        : undefined;
    case "abort":
      return str(c.sessionId)
        ? { type: "abort", sessionId: c.sessionId }
        : undefined;
    case "permission_response":
      return str(c.sessionId) &&
        str(c.requestId) &&
        (c.decision === "allow" ||
          c.decision === "always" ||
          c.decision === "deny")
        ? {
            type: "permission_response",
            sessionId: c.sessionId,
            requestId: c.requestId,
            decision: c.decision,
          }
        : undefined;
    case "set_model":
      return str(c.sessionId) &&
        str(c.model, 100) &&
        (c.effort === undefined || EFFORT_VALUES.includes(c.effort as Effort))
        ? {
            type: "set_model",
            sessionId: c.sessionId,
            model: c.model,
            effort: c.effort as Effort | undefined,
          }
        : undefined;
    case "close_session":
      return str(c.sessionId)
        ? { type: "close_session", sessionId: c.sessionId }
        : undefined;
    case "new_session":
      return c.workspaceId === null || str(c.workspaceId)
        ? {
            type: "new_session",
            workspaceId: c.workspaceId,
            readOnly: c.readOnly === true,
          }
        : undefined;
    case "open_session":
      return str(c.sessionId)
        ? { type: "open_session", sessionId: c.sessionId }
        : undefined;
    case "forget_workspace":
      return str(c.workspaceId)
        ? { type: "forget_workspace", workspaceId: c.workspaceId }
        : undefined;
    default:
      return undefined;
  }
}
