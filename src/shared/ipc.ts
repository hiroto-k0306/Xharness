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
  agentId?: string;
  input?: unknown;
  output?: string;
  id: string;
  sessionId: string;
  ts: number;
  provider: ProviderName | "harness" | "hook";
  model?: string;
  kind: "model_call" | "tool" | "permission" | "fallback" | "compact" | "hook";
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
  worktree?: { path: string; branch: string; baseBranch: string };
  permissionMode?: "default" | "acceptEdits" | "plan";
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
  models?: {
    id: string;
    provider: ProviderName;
    label: string;
    efforts: Effort[];
    defaultEffort?: Effort;
  }[];
  gitAvailable?: boolean;
  phase4?: boolean;
  fallback?: Partial<Record<ProviderName, string>>;
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

/** /mcp の表示(§25.8)。トークンなどの秘密は含めない */
export interface McpServerView {
  name: string;
  type: "stdio" | "http";
  status: "connected" | "failed" | "unapproved" | "rejected" | "needs_auth";
  tools: number;
  resources?: number;
  prompts?: number;
  error?: string;
  /** OAuth を使える(ログアウトを出す) */
  oauth?: boolean;
}
export interface McpPromptView {
  command: string;
  description?: string;
  arguments: { name: string; required: boolean }[];
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "mcp"; id: string; servers: McpServerView[] }
  | { kind: "assistant"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      tool: string;
      summary: string;
      status: "pending" | "ok" | "error" | "denied";
    }
  | {
      kind: "notice";
      id: string;
      tone: "dim" | "warn" | "err";
      text: string;
      phase?: string;
    };

/**
 * §16.4 の UiEvent。sessionId 付きのものは複数セッションの同時実行用の追加(§16.6)。
 * "state" / "transcript" / "user_message" / "turn" / "tool_result" / "permission_resolved" も追加分。
 */
export type UiEvent =
  | {
      type: "workflow";
      sessionId: string;
      phase: string;
      reviewRound: number;
      items: {
        id: string;
        status: string;
        title?: string;
        model?: string;
        agent?: string;
      }[];
      findings: {
        severity: "must" | "should" | "nit";
        file: string;
        line?: number;
        message: string;
      }[];
    }
  | {
      type: "agent_step";
      sessionId: string;
      agentId: string;
      step: StepNode;
      round: number;
    }
  | { type: "tool_progress"; sessionId: string; index: number; total: number }
  | { type: "notice"; sessionId: string; message: string; tone: "dim" | "warn" }
  | {
      type: "mcp";
      sessionId: string;
      servers: McpServerView[];
      prompts: McpPromptView[];
      /** /mcp で表示を求められた(会話欄に状態を出す) */
      show: boolean;
    }
  | { type: "repository_progress"; message: string }
  | { type: "receipt_history"; sessionId: string; receipts: Receipt[] }
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
      agentId?: string;
      plan?: unknown[];
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
      decision: PermissionDecision;
    }
  | { type: "receipt"; receipt: Receipt }
  | {
      type: "usage";
      provider: ProviderName;
      window5h?: number;
      weekly?: number;
      windows?: {
        name: string;
        usedPercent?: number;
        windowMinutes?: number;
        resetAt?: string;
      }[];
    }
  | {
      type: "agent";
      branch?: string;
      sessionId?: string;
      agentId: string;
      name: string;
      model: string;
      status: "running" | "done" | "error";
    }
  | { type: "agent_text"; sessionId: string; agentId: string; text: string }
  | {
      type: "agent_transcript";
      sessionId: string;
      agentId: string;
      items: TranscriptItem[];
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

export type PermissionDecision = "allow" | "always" | "session" | "deny";

export type HarnessCommand =
  | { type: "export_report"; sessionId: string }
  | {
      type: "plan_response";
      sessionId: string;
      requestId: string;
      items: unknown[];
    }
  | {
      type: "set_mode";
      sessionId: string;
      mode: "default" | "acceptEdits" | "plan";
    }
  | { type: "ready" }
  | { type: "abort_repository" }
  | { type: "send"; sessionId: string; text: string }
  | { type: "abort"; sessionId: string }
  | {
      type: "permission_response";
      sessionId: string;
      requestId: string;
      decision: PermissionDecision;
    }
  | { type: "set_model"; sessionId: string; model: string; effort?: Effort }
  | { type: "set_default_model"; model: string; effort?: Effort }
  | { type: "close_session"; sessionId: string }
  | {
      type: "new_session";
      workspaceId: string | null;
      readOnly?: boolean;
      isolated?: boolean;
      baseBranch?: string;
      newBranch?: string;
    }
  | {
      type: "open_repository";
      url: string;
      destination?: string;
      branch?: string;
      shallow?: boolean;
    }
  | {
      type: "finish_worktree";
      sessionId: string;
      action: "keep" | "merge" | "remove" | "remove_branch";
      confirmed?: boolean;
    }
  | { type: "restore_worktree"; sessionId: string; confirmed: boolean }
  | { type: "open_session"; sessionId: string }
  | { type: "pick_folder" }
  | { type: "forget_workspace"; workspaceId: string };

/** main が理由をすでに画面へ通知している失敗(画面側で重ねて表示しない) */
export const REPORTED_ERRORS: readonly string[] = [
  "Working directory not found",
  "Workspace folder not found",
];

export type CommandResult =
  | { ok: true; workspaceId?: string; sessionId?: string }
  | { ok: false; error: string };

/** preload が window.harness として公開する型付き API。これ以外は渡さない。 */
export interface HarnessApi {
  command(command: HarnessCommand): Promise<CommandResult>;
  onEvent(listener: (event: UiEvent) => void): () => void;
}

const MAX_TEXT = 200_000;
function jsonFits(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= MAX_TEXT;
  } catch {
    return false;
  }
}
const str = (v: unknown, max = 512): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= max;

/** 信頼できない入力(IPC)を検証する。不正なら undefined。 */
export function parseCommand(value: unknown): HarnessCommand | undefined {
  if (!value || typeof value !== "object") return undefined;
  const c = value as Record<string, unknown>;
  switch (c.type) {
    case "plan_response":
      return str(c.sessionId) &&
        str(c.requestId) &&
        Array.isArray(c.items) &&
        c.items.length <= 100 &&
        jsonFits(c.items)
        ? {
            type: "plan_response",
            sessionId: c.sessionId,
            requestId: c.requestId,
            items: c.items,
          }
        : undefined;
    case "ready":
    case "abort_repository":
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
          c.decision === "session" ||
          c.decision === "deny")
        ? {
            type: "permission_response",
            sessionId: c.sessionId,
            requestId: c.requestId,
            decision: c.decision,
          }
        : undefined;
    case "set_default_model":
      return str(c.model, 100) &&
        (c.effort === undefined || EFFORT_VALUES.includes(c.effort as Effort))
        ? {
            type: "set_default_model",
            model: c.model,
            effort: c.effort as Effort | undefined,
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
    case "set_mode":
      return str(c.sessionId) &&
        ["default", "acceptEdits", "plan"].includes(String(c.mode))
        ? {
            type: "set_mode",
            sessionId: c.sessionId,
            mode: c.mode as "default" | "acceptEdits" | "plan",
          }
        : undefined;
    case "export_report":
      return str(c.sessionId) && /^[\w-]{1,512}$/.test(c.sessionId)
        ? { type: "export_report", sessionId: c.sessionId }
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
            ...(c.isolated === undefined
              ? {}
              : { isolated: c.isolated === true }),
            ...(str(c.baseBranch) ? { baseBranch: c.baseBranch } : {}),
            ...(str(c.newBranch) ? { newBranch: c.newBranch } : {}),
          }
        : undefined;
    case "open_repository":
      return str(c.url, 2000) &&
        (c.destination === undefined || str(c.destination, 2000)) &&
        (c.branch === undefined || str(c.branch))
        ? {
            type: "open_repository",
            url: c.url,
            destination: c.destination as string | undefined,
            branch: c.branch as string | undefined,
            shallow: c.shallow === true,
          }
        : undefined;
    case "finish_worktree":
      return str(c.sessionId) &&
        ["keep", "merge", "remove", "remove_branch"].includes(String(c.action))
        ? {
            type: "finish_worktree",
            sessionId: c.sessionId,
            action: c.action as "keep" | "merge" | "remove" | "remove_branch",
            confirmed: c.confirmed === true,
          }
        : undefined;
    case "restore_worktree":
      return str(c.sessionId)
        ? {
            type: "restore_worktree",
            sessionId: c.sessionId,
            confirmed: c.confirmed === true,
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
