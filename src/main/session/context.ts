// SessionController と、それを分割した各モジュールが共有する型と小さな関数。
// electron を import しない。
import { stat } from "node:fs/promises";
import { traceJson } from "../core/trace.js";
import { type Authentication } from "../auth/authentication.js";
import { join } from "node:path";
import { type MainConfig, type WebSettings } from "../config/config.js";
import { type ProjectConfig } from "../config/project.js";
import { type Checkpoint } from "../context/compactor.js";
import { type Receipt as LoopReceipt } from "../core/loop.js";
import { type Rule } from "../core/permissions.js";
import { type Message } from "../core/types.js";
import { type Provider } from "../providers/provider.js";
import { FileAccess, fileTools } from "../tools/files.js";
import { type ToolRegistry } from "../tools/registry.js";
import { type ProviderUsage, type SearchBudget } from "../tools/web-search.js";
import { type McpConnector, type McpManager } from "../mcp/manager.js";
import { type McpOAuth, type SecretStore } from "../mcp/oauth.js";
import { type McpApprovals } from "../mcp/approvals.js";
import { type McpServerConfig } from "../mcp/config.js";
import { shellSearchTools } from "../tools/shell-search.js";
import { lifecycleTools } from "../tools/lifecycle.js";
import { todoTools } from "../tools/todos.js";
import { projectHistoryTools } from "../tools/project-history.js";
import { projectMemoryTools } from "../tools/project-memory.js";
import { projectSkillTools } from "../tools/project-skills.js";
import { type PlanItem } from "../workflow/plan-validate.js";
import { type WorkflowRuntime } from "../workflow/runtime.js";
import {
  type Effort,
  type PermissionDecision,
  type Receipt,
  type SessionStatus,
  type UiEvent,
} from "../../shared/ipc.js";
import { type WorkspaceTrust } from "../config/trust.js";
import { type ReceiptStore } from "./receipts.js";
import { type Repository } from "./repository.js";
import {
  JsonFile,
  type SessionStore,
  type StoredSession,
  type WorkspaceStore,
} from "./store.js";

export interface Host {
  pickFolder(): Promise<string | undefined>;
  saveReport?(filename: string): Promise<string | undefined>;
}
export interface ControllerOptions {
  /** Offline tests may control quota scheduling without advancing global timers. */
  quotaNow?(): number;
  quotaTimers?: boolean;
  authentication?: Authentication;
  cliModel?: string;
  cliEffort?: Effort;
  phase4?: boolean;
  web?: Partial<WebSettings> & {
    enabled: boolean;
    searchMode: "live" | "cached";
  };
  provider: Provider;
  providers?: Provider[];
  fallback?: Partial<Record<"claude" | "codex", string>>;
  /** 新しいセッションの既定モデルと effort(--model > 設定ファイル > claude:opus / high) */
  model: string;
  effort?: Effort;
  /** モデル名の別名(config.yaml の aliases)。省略時は §12 の既定 */
  aliases?: Record<string, string>;
  /** 起動時の警告(設定ファイルの不正値など)。最初の新規セッションで1度だけ通知する */
  warnings?: string[];
  /** ~/.xharness/(--fake のときは別の場所) */
  home: string;
  host: Host;
  emit(event: UiEvent): void;
  secrets?: string[];
  fake: boolean;
  version: string;
  createTools?(cwd: string, readOnly: boolean): ToolRegistry;
  /** 試験用: MCP の接続方法。指定すると --fake でも MCP を準備する(§25.10) */
  mcpConnector?: McpConnector;
  /** MCP の OAuth トークンの暗号化した保存先(アプリでは safeStorage。無ければ OAuth を使わない。§25.7) */
  mcpSecrets?: SecretStore;
  /** 認可の URL を既定のブラウザで開く */
  openExternal?(url: string): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

/** セッションごとの実行時状態(メモリ上のみ) */
export interface Runtime {
  /** A resumed request never inherits automatic tool confirmation. */
  quotaContinuation?: boolean;
  quotaGuard?: () => Promise<boolean>;
  lastStopCause?: string;
  evaluationTaskId?: string;
  childHandoffs?: import("../agents/handoffs.js").ChildHandoffs;
  llmCalls?: import("../../shared/llm-calls.js").LlmCalls;
  rewindPrompt?: {
    requestId: string;
    event?: Extract<UiEvent, { type: "rewind_request" }>;
    resolve(choice: import("../../shared/rewind.js").RewindChoice | null): void;
  };
  environment?: import("../tools/environment.js").EnvironmentReport;
  hookApproval?: {
    fingerprint: string;
    approve(signal: AbortSignal): Promise<boolean>;
  };
  workflow?: WorkflowRuntime;
  permissionTail?: Promise<void>;
  asked?: boolean;
  mainConfig?: MainConfig;
  checkpoint?: Checkpoint;
  receipts?: Receipt[];
  config?: ProjectConfig;
  sessionRules?: Rule[];
  messages: Message[];
  loaded: boolean;
  persisted: number;
  abort?: AbortController;
  status: SessionStatus;
  pending?: {
    event?: Extract<UiEvent, { type: "permission_request" }>;
    plan?: PlanItem[];
    requestId: string;
    resolve(decision: PermissionDecision): void;
  };
  always: Set<string>;
  tools?: ToolRegistry;
  /** セッションで最初に組み立てた system prompt(preserved thinking のため途中で変えない) */
  system?: string;
  /** Validated effective workflow prefix, memory only (manual Claude compact). */
  premises?: import("./premises.js").Premises;
  webSignature?: string;
  /** WebSearch の回数(子エージェントも合算。§22.5) */
  searchBudget?: SearchBudget;
  /** MCP の接続(セッション開始時に1回だけ準備する。§25.3) */
  mcp?: McpManager;
  mcpPrepared?: boolean;
  /** /mcp の操作に使う、セッション開始時の MCP の設定 */
  mcpSetup?: {
    root: string;
    servers: McpServerConfig[];
    approvals: McpApprovals;
    oauth?: McpOAuth;
    trusted: boolean;
  };
  receiptSeq: number;
  messageSeq: number;
  /** 実行中のターン(終了待ち用) */
  done?: Promise<void>;
  closing?: boolean;
  loading?: Promise<void>;
  /** このセッションの間だけ、ワークスペースの設定を信頼した */
  trustedSession?: boolean;
  /** 信頼を断った(このセッションでは再び尋ねない) */
  trustDeclined?: boolean;
}

export function createRuntime(): Runtime {
  return {
    messages: [],
    loaded: false,
    persisted: 0,
    status: "idle",
    always: new Set(),
    receiptSeq: 0,
    messageSeq: 0,
  };
}

/**
 * 分割した各モジュールが controller の内部へ触る窓口。
 * controller 自身がこれを実装し、モジュールはこの型だけに依存する。
 */
export interface ControllerContext {
  quotaPaused?(
    session: StoredSession,
    rt: Runtime,
    evidence: {
      rate: {
        provider: string;
        model: string;
        receivedAt: number;
        retryAfterSec?: number;
        scope?: string;
        windows?: import("../providers/provider.js").QuotaUsage["windows"];
      };
      unsafe: boolean;
      saved: boolean;
    },
  ): Promise<void>;
  readonly options: ControllerOptions;
  readonly sessions: SessionStore;
  readonly receipts: ReceiptStore;
  readonly workspaces: WorkspaceStore;
  readonly repository: Repository;
  readonly trust: WorkspaceTrust;
  /** 5時間枠の使用率(計画の検証用) */
  readonly quota: Partial<Record<"claude" | "codex", number>>;
  /** 枠ごとの最新の使用率とリセット時刻(Web 検索の auto 用。§22.2) */
  readonly usage: ProviderUsage;
  readonly worktreeBusy: Set<string>;
  /** Synchronous reservation covering send preparation and session operations. */
  readonly sessionBusy: Set<string>;
  clean(text: string): string;
  runtime(id: string): Runtime;
  existingRuntime(id: string): Runtime | undefined;
  dropRuntime(id: string): void;
  load(id: string): Promise<Runtime>;
  emitState(): Promise<void>;
  refreshCommands?(): Promise<void>;
  record(rt: Runtime, receipt: Receipt): Promise<void>;
  /** セッションが属するワークスペースのルート(指定なしなら undefined) */
  workspaceRoot(session: StoredSession): string | undefined;
}

export const STOP_NOTICE: Record<string, string> = {
  premise_mismatch:
    "保存履歴のsystem／toolsの前提が異なるか、旧形式のため照合できません。履歴は保持しています。/clear または新規セッションから続けてください。",
  budget_busy:
    "このセッションの通信処理が実行中です。終了してから再送信してください。",
  budget_exceeded:
    "通信回数の上限に達したため停止しました。上限の設定を確認してから新しい指示を入力してください。",
  budget_storage_failed:
    "通信回数を保存・読み込みできないため停止しました。保存先を確認してください。",
  agent_stopped:
    "エージェントの要求で停止しました。再開する場合は新しい指示を入力してください。",
  awaiting_user: "ユーザーの返答待ちです。入力欄から回答してください。",
  workflow_stalled:
    "作業状態が変わらないまま継続指示が繰り返されたため停止しました。依頼内容・対象フォルダ・失敗したツールを確認してから再開してください。",
  plan_validation_failed:
    "計画の形式エラーが3回繰り返されたため停止しました。計画内容を確認してから再開してください",
  context_overflow:
    "圧縮後もコンテキスト上限に収まりません。入力を短くするか新しいセッションを開始してください",
  rate_limited: "枠の上限に達しました。時間をおいて再試行してください",
  authentication:
    "認証エラー: 公式 CLI (claude / codex) で更新・再ログインしてから再試行してください",
  transport: "通信に失敗しました",
  protocol: "応答を解釈できませんでした",
  request: "リクエストが拒否されました",
  max_tokens: "出力上限に達しました",
  refusal: "モデルが応答を拒否しました",
  round_limit: "周回数の上限に達しました",
  consecutive_errors: "連続エラーのため停止しました",
  incomplete_response: "応答が途中で終了しました",
  step_failed: "内部エラーで停止しました",
  hook_failed: "フックの失敗で停止しました",
};

/** レシート番号の表示形式 `#0001` */
export const pad = (n: number) => "#" + String(n).padStart(4, "0");

/** 作業フォルダが無い(またはフォルダでない)ときの通知文。問題が無ければ undefined。 */
export async function missingDirectory(
  path: string,
): Promise<string | undefined> {
  try {
    if ((await stat(path)).isDirectory()) return undefined;
  } catch {
    /* 見つからない */
  }
  return `作業フォルダが見つかりません: ${path}(フォルダを戻すか、新しいセッションを作成してください)`;
}

/** 画面・記録へ出す前に、入力値の中の秘密値をマスクする */
export function safeInput(
  input: unknown,
  clean: (s: string) => string,
): unknown {
  try {
    return JSON.parse(traceJson(input, clean));
  } catch {
    return clean(String(input));
  }
}

export function toReceipt(
  r: LoopReceipt,
  sessionId: string,
  id: string,
): Receipt {
  const durationMs = Math.max(
    0,
    Date.parse(r.completedAt) - Date.parse(r.startedAt),
  );
  const isTool = r.provider === "tool";
  return {
    id,
    sessionId,
    ts: Date.parse(r.completedAt),
    provider: isTool ? "harness" : (r.provider as Receipt["provider"]),
    model: r.model,
    kind:
      r.provider === "hook"
        ? "hook"
        : r.decision === "fallback"
          ? "fallback"
          : isTool
            ? "tool"
            : "model_call",
    input: r.input,
    output: r.output,
    error: r.error,
    tool: r.tool,
    decision: isTool ? (r.decision === "error" ? "deny" : "allow") : undefined,
    durationMs,
    usage: r.usage,
    summary:
      r.provider === "hook"
        ? `hook ${r.timing}:${r.step} → ${r.tool ?? "workflow"} ${r.decision}`
        : `${r.tool ?? r.model}: ${r.decision}${r.error ? " · " + r.error.kind : ""}`,
  };
}

export function checkpointFile(home: string, id: string) {
  if (!/^[\w-]+$/.test(id)) throw new Error("Invalid session id");
  return new JsonFile<Checkpoint | undefined>(
    join(home, "context", `${id}.json`),
    (value): value is Checkpoint | undefined =>
      value === undefined ||
      (!!value &&
        typeof value === "object" &&
        Number.isSafeInteger((value as Checkpoint).covered) &&
        (value as Checkpoint).covered >= 0 &&
        typeof (value as Checkpoint).summary === "string"),
  );
}

export function defaultTools(cwd: string, readOnly: boolean): ToolRegistry {
  const access = new FileAccess(cwd);
  const all = new Map([
    ...fileTools(access),
    ...shellSearchTools(cwd),
    ...lifecycleTools(),
    ...todoTools(),
  ]);
  if (!readOnly) return all;
  // 読み取り専用で開いたセッションは plan 相当: 書き込み系ツールを渡さない(§9.1, §18.2)
  return new Map([...all].filter(([, tool]) => tool.readOnly));
}

/** History tools keep the parent's registered project scope, including children. */
export function sessionTools(
  ctx: ControllerContext,
  session: StoredSession,
  cwd = session.cwd,
): ToolRegistry {
  return new Map([
    ...(ctx.options.createTools ?? defaultTools)(cwd, session.readOnly),
    ...projectHistoryTools({
      home: ctx.options.home,
      sessions: ctx.sessions,
      workspaces: ctx.workspaces,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      cwd,
      clean: (text) => ctx.clean(text),
    }),
    ...projectMemoryTools(
      {
        home: ctx.options.home,
        sessions: ctx.sessions,
        workspaces: ctx.workspaces,
        sessionId: session.id,
        workspaceId: session.workspaceId,
        cwd,
        clean: (text) => ctx.clean(text),
      },
      !session.readOnly,
      () => ctx.options.emit({ type: "memory_changed", sessionId: session.id }),
    ),
    ...projectSkillTools({
      home: ctx.options.home,
      sessions: ctx.sessions,
      workspaces: ctx.workspaces,
      sessionId: session.id,
      workspaceId: session.workspaceId,
      cwd,
      clean: (text) => ctx.clean(text),
    }),
  ]);
}
