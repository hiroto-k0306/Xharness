import { loadModelCatalog } from "../config/model-catalog.js";
import { validatePlan, type PlanItem } from "../workflow/plan-validate.js";
import { projectHookApproval } from "../hooks/shell-hooks.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import { parse, stringify } from "yaml";
import { join, resolve } from "node:path";
import {
  isEffort,
  resolveModel,
  loadMainConfig,
  type MainConfig,
} from "../config/config.js";
import { Router } from "../core/router.js";
import { redact } from "../core/redact.js";
import { type Receipt as LoopReceipt } from "../core/loop.js";
import { childNeedsAsk } from "../agents/permissions.js";
import { type Message } from "../core/types.js";
import { type Provider } from "../providers/provider.js";
import { FileAccess, fileTools } from "../tools/files.js";
import { type ToolRegistry } from "../tools/registry.js";
import { shellSearchTools } from "../tools/shell-search.js";
import { webTools } from "../tools/web.js";
import {
  loadProjectConfig,
  projectMemory,
  saveRule,
  type ProjectConfig,
} from "../config/project.js";
import { decidePermission, grantFor, type Rule } from "../core/permissions.js";
import {
  STEP_NODES,
  type AppState,
  type CommandResult,
  type Effort,
  type HarnessCommand,
  type PermissionDecision,
  type Receipt,
  type SessionStatus,
  type UiEvent,
} from "../../shared/ipc.js";
import {
  SessionStore,
  usedProviders,
  WorkspaceStore,
  type StoredSession,
} from "./store.js";
import { summarizeInput } from "../../shared/summary.js";
import { itemsFromMessages } from "./transcript.js";
import { ReceiptStore } from "./receipts.js";
import { Repository } from "./repository.js";
import { WorkflowRuntime } from "../workflow/runtime.js";
import { loadAgentConfig } from "../agents/definitions.js";
import { waveChecks } from "../workflow/wave-checks.js";
import { JsonFile } from "./store.js";
import {
  prepareHistory,
  estimateTokens,
  type Checkpoint,
} from "../context/compactor.js";

export interface Host {
  pickFolder(): Promise<string | undefined>;
}
export interface ControllerOptions {
  cliModel?: string;
  cliEffort?: Effort;
  phase4?: boolean;
  web?: { enabled: boolean; searchMode: "live" | "cached" };
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
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

interface Runtime {
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
    plan?: PlanItem[];
    requestId: string;
    resolve(decision: PermissionDecision): void;
  };
  always: Set<string>;
  tools?: ToolRegistry;
  receiptSeq: number;
  messageSeq: number;
  /** 実行中のターン(終了待ち用) */
  done?: Promise<void>;
  closing?: boolean;
  loading?: Promise<void>;
}

const STOP_NOTICE: Record<string, string> = {
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
const pad = (n: number) => "#" + String(n).padStart(4, "0");

/** electron を import しない。UI(renderer)とは UiEvent / HarnessCommand だけで話す。 */
export class SessionController {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly sessions: SessionStore;
  private readonly receipts: ReceiptStore;
  private readonly repository: Repository;
  private readonly workspaces: WorkspaceStore;
  private current: string | null = null;
  private model: string;
  private effort: Effort;
  private warnings: string[];
  private stopped = false;
  private repositoryAbort?: AbortController;
  private readonly worktreeBusy = new Set<string>();
  private gitAvailable = true;
  private readonly clean: (text: string) => string;
  private readonly quota: Partial<Record<"claude" | "codex", number>> = {};

  constructor(private readonly options: ControllerOptions) {
    this.sessions = new SessionStore(options.home);
    this.receipts = new ReceiptStore(options.home);
    this.repository = new Repository(options.home);
    this.workspaces = new WorkspaceStore(options.home);
    this.model = options.model;
    this.effort = options.effort ?? "high";
    this.warnings = [...(options.warnings ?? [])];
    this.clean = (text) => redact(text, options.secrets ?? []);
  }

  async init() {
    await Promise.all([this.sessions.load(), this.workspaces.load()]);
    this.sessions.fillDefaults({ model: this.model, effort: this.effort });
    if (this.options.phase4) {
      this.gitAvailable = await this.repository.available();
      if (!this.gitAvailable)
        this.warnings.push(
          "Git が見つかりません。フォルダモードで使ってください",
        );
    }
    // 壊れた索引を退避したことなどは、最初の新規セッションで知らせる
    this.warnings.push(...this.sessions.warnings, ...this.workspaces.warnings);
  }

  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = {
        messages: [],
        loaded: false,
        persisted: 0,
        status: "idle",
        always: new Set(),
        receiptSeq: 0,
        messageSeq: 0,
      };
      this.runtimes.set(id, rt);
    }
    return rt;
  }
  private async load(id: string): Promise<Runtime> {
    const rt = this.runtime(id);
    // 同時に呼ばれても履歴の読み込みは1回だけ(後から届いた読み込みで追記済みの履歴を上書きしない)
    if (!rt.loaded)
      rt.loading ??= Promise.all([
        this.sessions.messages(id),
        this.receipts.read(id),
      ]).then(([messages, receipts]) => {
        if (rt.loaded) return;
        rt.messages = messages;
        rt.persisted = messages.length;
        rt.loaded = true;
        rt.receipts = receipts;
        rt.receiptSeq = Math.max(
          0,
          ...receipts.map((r) => Number(r.id.slice(1)) || 0),
        );
      });
    if (!rt.loaded) await rt.loading;
    return rt;
  }

  async state(): Promise<AppState> {
    const workspaces = await this.workspaces.summaries();
    const branch = new Map(workspaces.map((w) => [w.id, w.branch]));
    return {
      models: loadModelCatalog()
        .filter((m) => m.enabled)
        .map((m) => ({
          id: m.id,
          provider: m.provider,
          label: (m as typeof m & { displayName?: string }).displayName ?? m.id,
          efforts: Object.keys(m.efforts ?? {}) as Effort[],
          defaultEffort: m.defaultEffort,
        })),
      phase4: this.options.phase4,
      gitAvailable: this.gitAvailable,
      fallback: this.current
        ? (this.runtimes.get(this.current)?.mainConfig?.fallback ??
          this.options.fallback)
        : this.options.fallback,
      sessions: this.sessions.list().map((s) => ({
        ...s,
        status: this.runtimes.get(s.id)?.status ?? "idle",
        branch:
          s.worktree?.branch ??
          (s.workspaceId ? branch.get(s.workspaceId) : undefined),
      })),
      workspaces,
      currentSessionId: this.current,
      model: this.model,
      effort: this.effort,
      fake: this.options.fake,
      version: this.options.version,
    };
  }
  private async emitState() {
    this.options.emit({ type: "state", state: await this.state() });
  }

  async handle(command: HarnessCommand): Promise<CommandResult> {
    try {
      switch (command.type) {
        case "restore_worktree": {
          const session = this.sessions.get(command.sessionId);
          const root =
            session?.workspaceId &&
            this.workspaces.get(session.workspaceId)?.root;
          if (
            !session?.worktree ||
            !root ||
            this.runtime(session.id).status !== "idle" ||
            this.worktreeBusy.has(root)
          )
            return { ok: false, error: "Worktree unavailable or busy" };
          this.worktreeBusy.add(root);
          try {
            await this.repository.restore(
              root,
              session.worktree,
              command.confirmed,
              new AbortController().signal,
            );
            this.runtime(session.id).tools = undefined;
            await this.emitState();
            return { ok: true };
          } finally {
            this.worktreeBusy.delete(root);
          }
        }
        case "open_repository": {
          if (this.options.fake)
            return {
              ok: false,
              error: "Repository network operations are disabled in fake mode",
            };
          if (this.repositoryAbort)
            return { ok: false, error: "Repository operation busy" };
          this.repositoryAbort = new AbortController();
          let result;
          try {
            result = await this.repository.open(
              command,
              this.repositoryAbort.signal,
              (message) =>
                this.options.emit({ type: "repository_progress", message }),
            );
          } finally {
            this.repositoryAbort = undefined;
          }
          const workspaceId = await this.workspaces.add(
            result.root,
            Date.now(),
            result.remoteUrl,
          );
          await this.emitState();
          return { ok: true, workspaceId };
        }
        case "finish_worktree": {
          const session = this.sessions.get(command.sessionId);
          const root =
            session?.workspaceId &&
            this.workspaces.get(session.workspaceId)?.root;
          if (
            !session?.worktree ||
            !root ||
            this.runtime(session.id).status !== "idle" ||
            this.worktreeBusy.has(root)
          )
            return { ok: false, error: "Worktree unavailable or busy" };
          if (
            command.action === "merge" &&
            this.sessions
              .list()
              .some(
                (s) =>
                  s.workspaceId === session.workspaceId &&
                  !s.worktree &&
                  !s.readOnly &&
                  (this.runtimes.get(s.id)?.status ?? "idle") !== "idle",
              )
          )
            return { ok: false, error: "Workspace writer busy" };
          this.worktreeBusy.add(root);
          try {
            await this.repository.finish(
              root,
              session.worktree,
              command.action,
              !!command.confirmed,
              new AbortController().signal,
            );
            if (
              command.action === "remove" ||
              command.action === "remove_branch"
            ) {
              await this.sessions.save({
                ...session,
                worktree: undefined,
                cwd: root,
              });
              this.runtime(session.id).tools = undefined;
            }
            await this.emitState();
            return { ok: true };
          } finally {
            this.worktreeBusy.delete(root);
          }
        }
        case "abort_repository":
          this.repositoryAbort?.abort();
          return { ok: true };
        case "set_mode": {
          const session = this.sessions.get(command.sessionId);
          if (!session || (session.readOnly && command.mode !== "plan"))
            return { ok: false, error: "Mode unavailable" };
          await this.sessions.save({
            ...session,
            permissionMode: command.mode,
          });
          const rt = await this.load(session.id);
          await this.record(rt, {
            id: pad(++rt.receiptSeq),
            sessionId: session.id,
            ts: Date.now(),
            provider: "harness",
            kind: "permission",
            durationMs: 0,
            summary: `Mode: ${command.mode}`,
          });
          await this.emitState();
          return { ok: true };
        }
        case "ready": {
          await this.emitState();
          if (this.current) {
            await this.emitTranscript(this.current);
            const session = this.sessions.get(this.current);
            if (session) await this.reportMissingCwd(session);
          }
          return { ok: true };
        }
        case "new_session":
          return await this.newSession(
            command.workspaceId,
            !!command.readOnly,
            command.isolated,
            command.baseBranch,
            command.newBranch,
          );
        case "open_session": {
          if (!this.sessions.get(command.sessionId))
            return { ok: false, error: "Unknown session" };
          this.current = command.sessionId;
          await this.emitState();
          await this.emitTranscript(command.sessionId);
          // §18.4: 再開時に cwd の存在を確認する。無ければ実行できないことを知らせる
          await this.reportMissingCwd(this.sessions.get(command.sessionId)!);
          this.flushWarnings(command.sessionId);
          return { ok: true, sessionId: command.sessionId };
        }
        case "pick_folder": {
          const folder = await this.options.host.pickFolder();
          if (!folder) return { ok: false, error: "cancelled" };
          const workspaceId = await this.workspaces.add(folder);
          await this.emitState();
          return { ok: true, workspaceId };
        }
        case "forget_workspace":
          await this.workspaces.forget(command.workspaceId);
          await this.emitState();
          return { ok: true };
        case "set_model":
          return await this.setModel(
            command.sessionId,
            command.model,
            command.effort,
          );
        case "close_session":
          return await this.closeSession(command.sessionId);
        case "send":
          return this.send(command.sessionId, command.text);
        case "abort": {
          const rt = this.runtimes.get(command.sessionId);
          if (rt) this.release(rt);
          return { ok: true };
        }
        case "plan_response": {
          const rt = this.runtimes.get(command.sessionId);
          if (!rt?.pending?.plan || rt.pending.requestId !== command.requestId)
            return { ok: false, error: "No such plan approval" };
          const validation = validatePlan(command.items, loadModelCatalog(), {
            aliases: rt.mainConfig?.aliases ?? this.options.aliases,
          });
          if (validation.errors.length)
            return { ok: false, error: "Invalid plan assignment" };
          rt.pending.plan.splice(
            0,
            rt.pending.plan.length,
            ...(structuredClone(command.items) as PlanItem[]),
          );
          rt.pending.resolve("allow");
          return { ok: true };
        }
        case "set_default_model": {
          const model = loadModelCatalog().find(
            (m) => m.enabled && m.id === command.model,
          );
          if (
            !model ||
            (command.effort && model.efforts && !model.efforts[command.effort])
          )
            return { ok: false, error: "Unavailable model or effort" };
          const path = join(this.options.home, "config.yaml");
          let doc: Record<string, unknown> = {};
          try {
            doc = parse(await readFile(path, "utf8")) ?? {};
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          if (!doc || typeof doc !== "object" || Array.isArray(doc))
            throw new Error("Invalid configuration");
          const effort = command.effort ?? model.defaultEffort ?? "high";
          doc.main = { model: command.model, effort };
          const temp = path + "." + randomUUID() + ".tmp";
          await mkdir(this.options.home, { recursive: true });
          await writeFile(temp, stringify(doc));
          await rename(temp, path);
          if (!this.options.cliModel) this.model = command.model;
          if (!this.options.cliEffort) this.effort = effort;
          await this.emitState();
          return { ok: true };
        }
        case "permission_response": {
          const rt = this.runtimes.get(command.sessionId);
          if (rt?.pending?.requestId !== command.requestId)
            return { ok: false, error: "No such permission request" };
          rt.pending.resolve(command.decision);
          return { ok: true };
        }
      }
    } catch {
      // 例外の本文には資格情報やパスが入りうるので、画面には汎用文だけを返す。
      return { ok: false, error: "Command failed" };
    }
  }

  private async newSession(
    workspaceId: string | null,
    readOnly: boolean,
    isolated = false,
    baseBranch?: string,
    newBranch?: string,
  ): Promise<CommandResult> {
    const id = randomUUID().slice(0, 8);
    let cwd: string;
    if (workspaceId) {
      const ws = this.workspaces.get(workspaceId);
      if (!ws) return { ok: false, error: "Unknown workspace" };
      cwd = ws.root;
      if (this.worktreeBusy.has(cwd))
        return { ok: false, error: "Workspace writer busy" };
      const missing = await missingDirectory(cwd);
      if (missing) {
        this.options.emit({
          type: "error",
          sessionId: this.current ?? undefined,
          message: missing,
        });
        return { ok: false, error: "Workspace folder not found" };
      }
      await this.workspaces.touch(workspaceId);
    } else {
      // §18.5: 指定なしのセッションはセッション専用の空フォルダで作業する
      cwd = join(this.options.home, "scratch", id);
      await mkdir(cwd, { recursive: true });
    }
    const now = Date.now();
    const worktree =
      isolated && workspaceId
        ? await this.repository.createWorktree(
            cwd,
            workspaceId,
            id,
            new AbortController().signal,
            baseBranch,
            newBranch,
          )
        : undefined;
    if (worktree) cwd = worktree.path;
    const projectMain =
      this.options.phase4 && workspaceId && !this.options.fake
        ? await loadMainConfig(
            this.options.home,
            undefined,
            this.workspaces.get(workspaceId)?.root,
          )
        : undefined;
    const session: StoredSession = {
      id,
      title: "New session",
      workspaceId,
      cwd,
      worktree,
      readOnly,
      model: this.options.cliModel
        ? this.model
        : (projectMain?.choice.model ?? this.model),
      effort:
        this.options.cliEffort ?? projectMain?.choice.effort ?? this.effort,
      createdAt: now,
      updatedAt: now,
      providers: [],
      ...(this.options.phase4
        ? {
            permissionMode: readOnly
              ? "plan"
              : (
                  await loadProjectConfig(
                    this.options.home,
                    workspaceId
                      ? this.workspaces.get(workspaceId)?.root
                      : undefined,
                  )
                ).permissions.mode,
          }
        : {}),
    };
    await this.sessions.save(session);
    this.runtime(id).loaded = true;
    this.current = id;
    await this.emitState();
    this.options.emit({ type: "transcript", sessionId: id, items: [] });
    this.flushWarnings(id);
    return { ok: true, sessionId: id };
  }

  private async emitTranscript(id: string) {
    const rt = this.runtimes.get(id);
    if (rt && rt.status !== "idle") return; // 実行中は画面側が最新を持っている
    const loaded = await this.load(id);
    this.options.emit({
      type: "transcript",
      sessionId: id,
      items: itemsFromMessages(loaded.messages),
    });
    this.options.emit({
      type: "receipt_history",
      sessionId: id,
      receipts: loaded.receipts ?? [],
    });
  }

  private async send(sessionId: string, text: string): Promise<CommandResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Unknown session" };
    if (this.stopped) return { ok: false, error: "Shutting down" };
    const root =
      session.workspaceId && this.workspaces.get(session.workspaceId)?.root;
    if (root && this.worktreeBusy.has(root))
      return { ok: false, error: "Workspace writer busy" };
    if (/^\/mode(?:\s|$)/.test(text.trim())) {
      const [, mode, extra] = text.trim().split(/\s+/);
      if (extra || !["default", "acceptEdits", "plan"].includes(mode ?? ""))
        return { ok: false, error: "Usage: /mode default|acceptEdits|plan" };
      return this.handle({
        type: "set_mode",
        sessionId,
        mode: mode as "default" | "acceptEdits" | "plan",
      });
    }
    if (text.trim() === "/compact") {
      const rt = await this.load(sessionId);
      if (rt.status !== "idle")
        return { ok: false, error: "Turn already running" };
      rt.checkpoint ??= await this.checkpointFile(sessionId).read(undefined);
      const result = prepareHistory(rt.messages, {
        checkpoint: rt.checkpoint,
        threshold: 0.8,
        force: true,
      });
      if (result.checkpoint) {
        rt.checkpoint = result.checkpoint;
        await this.checkpointFile(sessionId).write(result.checkpoint);
      }
      if (result.compacted)
        await this.record(rt, {
          id: pad(++rt.receiptSeq),
          sessionId,
          ts: Date.now(),
          provider: "harness",
          kind: "compact",
          durationMs: 0,
          summary: "Manual compact",
        });
      this.options.emit({
        type: "notice",
        tone: "dim",
        sessionId,
        message: result.compacted
          ? "古い履歴を圧縮しました（元の履歴は保存済み）"
          : "圧縮できる古い履歴がありません",
      });
      return { ok: true };
    }
    if (/^\/model(?:\s|$)/.test(text.trim())) {
      const [, model, effort, extra] = text.trim().split(/\s+/);
      if (!model || extra || (effort !== undefined && !isEffort(effort)))
        return { ok: false, error: "Usage: /model provider:model [effort]" };
      return this.setModel(sessionId, model, effort as Effort | undefined);
    }
    const rt = await this.load(sessionId);
    if (rt.status !== "idle") {
      if (/^\/(?:phase|review)(?:\s|$)/.test(text.trim()) && rt.workflow) {
        const [command, phase, extra] = text.trim().split(/\s+/);
        if (extra || (command === "/review" && phase))
          return { ok: false, error: "Invalid phase command" };
        rt.workflow.queuePhase(
          command === "/review" ? "review" : (phase ?? ""),
        );
        this.options.emit({
          type: "notice",
          sessionId,
          tone: "dim",
          message: "段階の変更を次の STEP 6 終了時に反映します",
        });
        return { ok: true };
      }
      return { ok: false, error: "Turn already running" };
    }
    if (/^\/(?:phase|review)(?:\s|$)/.test(text.trim())) {
      const [command, phase, extra] = text.trim().split(/\s+/);
      if (!rt.workflow || extra || (command === "/review" && phase))
        return { ok: false, error: "No workflow or invalid phase command" };
      const requested = command === "/review" ? "review" : (phase ?? "");
      rt.workflow.manualPhase(requested);
      if (requested !== "review") return { ok: true };
    }
    if (
      !session.readOnly &&
      !session.worktree &&
      session.workspaceId &&
      this.sessions
        .list()
        .some(
          (other) =>
            other.id !== sessionId &&
            other.workspaceId === session.workspaceId &&
            !other.readOnly &&
            !other.worktree &&
            this.runtimes.get(other.id)?.status !== undefined &&
            this.runtimes.get(other.id)?.status !== "idle",
        )
    ) {
      this.options.emit({
        type: "error",
        sessionId,
        message:
          "同じワークスペースで書き込みセッションが実行中です。読み取り専用か worktree を使ってください",
      });
      return { ok: false, error: "Workspace writer busy" };
    }
    // 確認より前に同期的に予約する(次の await の間に届いた二重送信を弾く)
    rt.status = "running";
    // 作業フォルダが無いときは、モデルを呼ばずツールも動かさずに知らせる(§18.4)
    if (await this.reportMissingCwd(session)) {
      rt.status = "idle";
      return { ok: false, error: "Working directory not found" };
    }
    rt.closing = false;
    rt.done = this.runSession(session, rt, text).catch(() => undefined);
    return { ok: true, sessionId };
  }

  /** 起動時の警告を、最初に開いた(作った)セッションへ一度だけ出す */
  private flushWarnings(sessionId: string) {
    for (const message of this.warnings.splice(0))
      this.options.emit({ type: "error", sessionId, message });
  }

  private async reportMissingCwd(session: StoredSession): Promise<boolean> {
    const missing = await missingDirectory(session.cwd);
    if (!missing) return false;
    this.options.emit({
      type: "error",
      sessionId: session.id,
      message: missing,
    });
    return true;
  }

  /** このセッションだけのモデル・effort を変える。進行中の周は中断せず、次の周から反映する(§16.8) */
  private async setModel(
    sessionId: string,
    spec: string,
    effort?: Effort,
  ): Promise<CommandResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Unknown session" };
    const cfg = this.options.phase4
      ? await loadMainConfig(
          this.options.home,
          undefined,
          session.workspaceId
            ? this.workspaces.get(session.workspaceId)?.root
            : undefined,
        )
      : undefined;
    const resolved = resolveModel(spec, cfg?.aliases ?? this.options.aliases);
    const known =
      resolved &&
      (this.options.providers ?? [this.options.provider]).some((p) =>
        p.models().some((m) => m.id === resolved.model),
      );
    if (!resolved || !known) return { ok: false, error: "Unknown model" };
    if (effort !== undefined && !isEffort(effort))
      return { ok: false, error: "Unknown effort" };
    const catalog = loadModelCatalog().find(
      (m) => m.enabled && m.id === resolved.model,
    );
    if (
      resolved.model !== "fake" &&
      (!catalog || (effort && catalog.efforts && !catalog.efforts[effort]))
    )
      return { ok: false, error: "Unavailable model or effort" };
    await this.sessions.save({
      ...session,
      model: resolved.model,
      effort: effort ?? session.effort,
    });
    await this.emitState();
    return { ok: true, sessionId };
  }

  /**
   * セッションを閉じる。権限待ちは deny で解決し、実行中のターンは中断する。
   * 履歴は残る(一覧からは消えない)。
   */
  private async closeSession(sessionId: string): Promise<CommandResult> {
    if (!this.sessions.get(sessionId))
      return { ok: false, error: "Unknown session" };
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.closing = true;
      this.release(rt);
      if (rt.status === "idle") this.runtimes.delete(sessionId);
    }
    if (this.current === sessionId) this.current = null;
    await this.emitState();
    return { ok: true };
  }

  /** 権限待ちを deny で解決し、ターンを中断する(待ちが残ってループが止まったままにならないように) */
  private release(rt: Runtime) {
    rt.pending?.resolve("deny");
    rt.abort?.abort();
  }

  /** アプリ終了前に呼ぶ。全セッションの権限待ちを deny にして中断し、履歴の保存まで待つ。 */
  async shutdown(timeoutMs = 3000): Promise<void> {
    this.stopped = true;
    this.repositoryAbort?.abort();
    const running: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) {
      this.release(rt);
      if (rt.done) running.push(rt.done);
    }
    await Promise.race([
      Promise.all(running),
      new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.()),
    ]);
  }

  private async system(
    cwd: string,
    scratch = false,
    config?: ProjectConfig,
  ): Promise<string> {
    let system = `You are a coding agent working in ${cwd}. Use Read before modifying existing files. Bash executes PowerShell 7. Tool dates use ISO 8601. Respect project instructions. Reply in Japanese unless asked otherwise.`;
    if (config)
      return (
        system +
        "\n\n" +
        this.clean(
          await projectMemory(
            this.options.home,
            scratch ? undefined : cwd,
            config.context.memoryFiles,
          ),
        )
      );
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      try {
        system +=
          `\n\n${name}:\n` +
          this.clean(await readFile(resolve(cwd, name), "utf8"));
      } catch {
        /* 任意のファイル */
      }
    }
    return system;
  }

  private async runSession(session: StoredSession, rt: Runtime, text: string) {
    const receiptWrites: Promise<void>[] = [];
    const { emit } = this.options;
    const sessionId = session.id;
    const clean = this.clean;
    const record = (receipt: Receipt) => {
      const write = this.receipts.append(sessionId, [receipt], clean);
      void write.catch(() => undefined);
      receiptWrites.push(write);
      (rt.receipts ??= []).push(receipt);
      emit({ type: "receipt", receipt });
    };
    const abort = new AbortController();
    rt.abort = abort;
    const calls: { callId: string; receiptId: string }[] = [];
    const receiptByCall = new Map<string, string>();
    let buffer = "";
    let activeProvider = this.options.provider.id;
    const messageId = () => `${sessionId}-m${rt.messageSeq}`;
    const flush = () => {
      if (buffer)
        emit({
          type: "text_delta",
          sessionId,
          messageId: messageId(),
          text: clean(buffer),
        });
      buffer = "";
    };
    const first = rt.messages.length === 0;
    rt.messages.push({
      role: "user",
      content: [{ type: "text", text: clean(text) }],
    });
    if (first) {
      session = {
        ...(this.sessions.get(sessionId) ?? session),
        title:
          clean(text).replace(/\s+/g, " ").trim().slice(0, 40) || session.title,
      };
      await this.sessions.save(session);
    }
    // new_session の transcript と invoke の返答は別チャネル。発言も main の
    // イベント順に流し、遅れて届いた空の transcript が発言を消す競合を防ぐ。
    emit({
      type: "user_message",
      sessionId,
      messageId: `${sessionId}-u${rt.messages.length}`,
      text: clean(text),
    });
    emit({ type: "turn", sessionId, status: "running" });
    await this.emitState();
    let stopCause = "step_failed";
    try {
      rt.tools ??= (this.options.createTools ?? defaultTools)(
        // Per-session policies are evaluated at the permission gate.
        session.cwd,
        session.readOnly,
      );
      if (this.options.phase4)
        rt.config = await loadProjectConfig(
          this.options.home,
          session.workspaceId
            ? this.workspaces.get(session.workspaceId)?.root
            : undefined,
        );
      if (this.options.phase4)
        rt.mainConfig = await loadMainConfig(
          this.options.home,
          undefined,
          session.workspaceId
            ? this.workspaces.get(session.workspaceId)?.root
            : undefined,
        );
      const web = rt.mainConfig?.web ?? this.options.web;
      rt.tools.delete("WebSearch");
      rt.tools.delete("WebFetch");
      if (web?.enabled) {
        for (const [name, tool] of webTools(
          () =>
            new Router(
              this.options.providers ?? [this.options.provider],
            ).provider((this.sessions.get(sessionId) ?? session).model),
          web.searchMode,
          this.options.fake,
          (event) => {
            if (event.type === "usage")
              emit({
                type: "usage",
                provider: event.provider,
                windows: event.windows,
                window5h: event.windows.find((w) => w.windowMinutes === 300)
                  ?.usedPercent,
                weekly: event.windows.find((w) => w.windowMinutes === 10080)
                  ?.usedPercent,
              });
          },
        ))
          rt.tools.set(name, tool);
      }
      if (this.options.phase4 && !rt.checkpoint)
        rt.checkpoint = await this.checkpointFile(sessionId).read(undefined);
      const system = await this.system(
        session.cwd,
        !session.workspaceId,
        rt.config,
      );
      const agentConfig = await loadAgentConfig(
        this.options.home,
        session.workspaceId ? session.cwd : undefined,
      );
      if (
        !rt.workflow ||
        (!rt.workflow.manualReview &&
          ["off", "complete", "attention"].includes(rt.workflow.state.phase))
      ) {
        const fingerprint = JSON.stringify(agentConfig.hooks ?? []);
        const approveHooks =
          rt.hookApproval?.fingerprint === fingerprint
            ? rt.hookApproval.approve
            : projectHookApproval(agentConfig.hooks ?? [], (hooks, signal) =>
                this.askPermission(
                  session,
                  rt,
                  { name: "ProjectHooks", input: { hooks } },
                  undefined,
                  signal,
                  true,
                ),
              );
        rt.hookApproval = { fingerprint, approve: approveHooks };
        rt.workflow = new WorkflowRuntime({
          approveHooks: (_hooks, signal) => approveHooks(signal),
          home: this.options.home,
          parentId: sessionId,
          cwd: session.cwd,
          config: agentConfig,
          quota: this.quota,
          aliases: rt.mainConfig?.aliases ?? this.options.aliases,
          router: new Router(
            this.options.providers ?? [this.options.provider],
            rt.mainConfig?.fallback ?? this.options.fallback,
            rt.mainConfig?.aliases ?? this.options.aliases,
          ),
          createTools: (cwd) => {
            const tools = (this.options.createTools ?? defaultTools)(
              cwd,
              session.readOnly,
            );
            if (web?.enabled)
              for (const [name, tool] of webTools(
                () => this.options.provider,
                web.searchMode,
                this.options.fake,
              ))
                tools.set(name, tool);
            return tools;
          },
          permission: async (call, context, signal) =>
            call.name === "ReportDone"
              ? Promise.resolve(true)
              : this.askPermission(
                  { ...session, cwd: context.cwd },
                  rt,
                  call,
                  undefined,
                  signal,
                  await childNeedsAsk(call, context),
                  context.name,
                  context.id,
                ),
          approve: (items, notes, warnings, signal) =>
            this.askPermission(
              session,
              rt,
              { name: "SubmitPlan", input: { items, notes, warnings } },
              undefined,
              signal,
              true,
            ),
          onStatus: (context, model, status) =>
            emit({
              type: "agent",
              sessionId,
              agentId: context.id,
              name: context.name,
              model,
              status,
              branch: context.branch,
            }),
          onTranscript: (context, messages) =>
            emit({
              type: "agent_transcript",
              sessionId,
              agentId: context.id,
              items: itemsFromMessages(safeInput(messages, clean) as Message[]),
            }),
          onEvent: (context, event) => {
            if (event.type === "text_delta")
              emit({
                type: "agent_text",
                sessionId,
                agentId: context.id,
                text: clean(event.text),
              });
            if (event.type === "receipt") {
              if (event.receipt.provider === "hook" && !event.receipt.tool)
                return;
              const receipt = toReceipt(
                event.receipt,
                sessionId,
                pad(++rt.receiptSeq),
              );
              receipt.agentId = context.id;
              receipt.input = safeInput(receipt.input, clean);
              receipt.output = clean(receipt.output ?? "");
              receipt.summary = context.name + " · " + clean(receipt.summary);
              record(receipt);
            }
            if (event.type === "step")
              emit({
                type: "agent_step",
                sessionId,
                agentId: context.id,
                step: event.step,
                round: event.round,
              });
            if (event.type === "usage") {
              this.updateQuota(event);
              emit({ ...event });
            }
          },
          onPhase: (workflow) => {
            emit({ type: "workflow", sessionId, ...workflow });
            if (["complete", "attention"].includes(workflow.phase))
              emit({
                type: "notice",
                sessionId,
                tone: workflow.phase === "complete" ? "dim" : "warn",
                message: clean(
                  (workflow.phase === "complete"
                    ? "レビュー完了。修正必須の指摘はありません。"
                    : "レビューの往復上限に達しました。残る必須指摘を確認してください。") +
                    workflow.findings
                      .map(
                        (f) =>
                          `\n${f.severity}: ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`,
                      )
                      .join(""),
                ),
              });
          },
          redact: clean,
          waveChecks: waveChecks(
            agentConfig.waveChecks,
            shellSearchTools(session.cwd).get("Bash")!,
            (_hooks, signal) => approveHooks(signal),
            (hook, output, ok, durationMs) =>
              record({
                id: pad(++rt.receiptSeq),
                sessionId,
                ts: Date.now(),
                provider: "harness",
                kind: "tool",
                tool: "WaveCheck",
                decision: ok ? "allow" : "deny",
                durationMs,
                summary: `WaveCheck ${hook.id}: ${ok ? "passed" : "failed"}`,
                input: safeInput(hook, clean),
                output: clean(output),
              }),
          ),
        });
      }
      const result = await rt.workflow.run(
        {
          prepareContext: this.options.phase4
            ? async (messages, route, signal, context) => {
                signal.throwIfAborted();
                const limit = route.provider
                  .models()
                  .find((m) => m.id === route.model)?.contextTokens;
                const prepared = prepareHistory(messages, {
                  checkpoint: rt.checkpoint,
                  limit,
                  threshold: rt.config?.context.compactThreshold ?? 0.8,
                  overhead:
                    estimateTokens({
                      system: context?.system ?? system,
                      tools:
                        context?.tools ??
                        [...rt.tools!.values()].map((t) => t.spec),
                    }) + 4096,
                });
                if (prepared.compacted && prepared.checkpoint) {
                  rt.checkpoint = prepared.checkpoint;
                  await this.checkpointFile(sessionId).write(
                    prepared.checkpoint,
                  );
                  const receipt: Receipt = {
                    id: pad(++rt.receiptSeq),
                    sessionId,
                    ts: Date.now(),
                    provider: "harness",
                    kind: "compact",
                    durationMs: 0,
                    summary: `Compacted ${prepared.checkpoint.covered} older messages`,
                  };
                  record(receipt);
                }
                return {
                  messages: prepared.messages,
                  ...(!prepared.fits ? { stop: "context_overflow" } : {}),
                };
              }
            : undefined,
          provider: this.options.provider,
          router: this.options.providers
            ? new Router(
                this.options.providers,
                rt.mainConfig?.fallback ?? this.options.fallback,
                rt.mainConfig?.aliases ?? this.options.aliases,
              )
            : undefined,
          sessionId,
          onFallback: async (route) => {
            activeProvider = route.provider.id;
            const latest = this.sessions.get(sessionId) ?? session;
            await this.sessions.save({
              ...latest,
              model: route.model,
              effort: route.reasoning?.effort ?? latest.effort,
            });
            emit({
              type: "error",
              sessionId,
              message: `↻ fallback: ${route.model}`,
            });
            await this.emitState();
          },
          model: session.model,
          reasoning: { effort: session.effort },
          // 各周の STEP 1 で、このセッションの最新のモデルを読む
          current: () => {
            const latest = this.sessions.get(sessionId) ?? session;
            activeProvider =
              resolveModel(latest.model)?.provider ?? this.options.provider.id;
            return {
              model: latest.model,
              reasoning: { effort: latest.effort },
            };
          },
          system,
          messages: rt.messages,
          tools: rt.tools,
          redact: clean,
          sleep: this.options.sleep,
          permission: async (call, signal) => {
            const started = Date.now();
            const allowed = await this.askPermission(
              session,
              rt,
              call,
              receiptByCall.get(call.id),
              signal,
            );
            if (this.options.phase4) {
              const receipt: Receipt = {
                id: pad(++rt.receiptSeq),
                sessionId,
                ts: Date.now(),
                provider: "harness",
                kind: "permission",
                tool: call.name,
                decision: rt.asked
                  ? allowed
                    ? "ask→allow"
                    : "ask→deny"
                  : allowed
                    ? "allow"
                    : "deny",
                durationMs: Date.now() - started,
                summary: `${call.name}: ${allowed ? "allow" : "deny"}`,
                input: safeInput(call.input, clean),
              };
              record(receipt);
            }
            return allowed;
          },
          onEvent: (event) => {
            switch (event.type) {
              case "tool_progress":
                emit({ ...event, sessionId });
                break;
              case "usage":
                this.updateQuota(event);
                emit({
                  type: "usage",
                  provider: event.provider,
                  windows: event.windows,
                  window5h: event.windows.find((w) => w.windowMinutes === 300)
                    ?.usedPercent,
                  weekly: event.windows.find((w) => w.windowMinutes === 10080)
                    ?.usedPercent,
                });
                break;
              case "step":
                emit({
                  type: "step",
                  sessionId,
                  step: (STEP_NODES.indexOf(event.step) + 1) as 1,
                  node: event.step,
                  round: event.round,
                });
                break;
              case "text_delta": {
                buffer += event.text;
                const cut = Math.max(
                  buffer.lastIndexOf(" "),
                  buffer.lastIndexOf("\n"),
                  buffer.lastIndexOf("\t"),
                );
                if (cut >= 0) {
                  const head = buffer.slice(0, cut + 1);
                  buffer = buffer.slice(cut + 1);
                  emit({
                    type: "text_delta",
                    sessionId,
                    messageId: messageId(),
                    text: clean(head),
                  });
                }
                break;
              }
              case "message_done":
                flush();
                rt.messageSeq++;
                break;
              case "tool_use": {
                const receiptId = pad(++rt.receiptSeq);
                calls.push({ callId: event.id, receiptId });
                receiptByCall.set(event.id, receiptId);
                emit({
                  type: "tool_call",
                  sessionId,
                  receiptId,
                  provider:
                    resolveModel(
                      rt.workflow?.mainModel ??
                        (this.sessions.get(sessionId) ?? session).model,
                    )?.provider ?? activeProvider,
                  tool: event.name,
                  input: safeInput(event.input, clean),
                });
                break;
              }
              case "receipt": {
                const r = event.receipt;
                if (r.provider === "hook" && !r.tool) break;
                if (r.provider === "tool") {
                  const call = calls.shift();
                  if (call)
                    emit({
                      type: "tool_result",
                      sessionId,
                      receiptId: call.receiptId,
                      isError: r.decision === "error",
                    });
                }
                const receipt = toReceipt(r, sessionId, pad(++rt.receiptSeq));
                receipt.input = safeInput(receipt.input, clean);
                receipt.summary = clean(receipt.summary);
                if (receipt.output) receipt.output = clean(receipt.output);
                record(receipt);
                break;
              }
              case "rate_limited":
                emit({
                  type: "error",
                  sessionId,
                  message: `枠の上限(429)。待ち時間: ${event.retryAfterSec ?? "不明"} 秒`,
                });
                break;
              case "error":
                emit({
                  type: "error",
                  sessionId,
                  message: clean(event.error.message),
                });
                break;
            }
          },
        },
        abort.signal,
      );
      flush();
      rt.messages = result.messages;
      stopCause = result.stopCause;
    } catch {
      flush();
      stopCause = abort.signal.aborted ? "aborted" : "step_failed";
      if (!abort.signal.aborted)
        emit({ type: "error", sessionId, message: "内部エラーで停止しました" });
    }
    try {
      await Promise.all(receiptWrites);
      await this.sessions.append(
        sessionId,
        rt.messages.slice(rt.persisted),
        clean,
      );
      rt.persisted = rt.messages.length;
      // 実行中に set_model された内容を上書きしないよう、最新の記録に重ねて保存する
      const latest = this.sessions.get(sessionId) ?? session;
      await this.sessions.save({
        ...latest,
        updatedAt: Date.now(),
        providers: usedProviders(rt.messages, latest.providers),
      });
    } catch {
      emit({ type: "error", sessionId, message: "履歴の保存に失敗しました" });
    }
    rt.abort = undefined;
    rt.pending = undefined;
    rt.status = "idle";
    const notice = STOP_NOTICE[stopCause];
    if (notice && stopCause !== "aborted")
      emit({ type: "error", sessionId, message: notice });
    emit({ type: "turn", sessionId, status: "idle", stopCause });
    if (rt.closing) this.runtimes.delete(sessionId);
    await this.emitState();
  }

  private checkpointFile(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid session id");
    return new JsonFile<Checkpoint | undefined>(
      join(this.options.home, "context", `${id}.json`),
      (value): value is Checkpoint | undefined =>
        value === undefined ||
        (!!value &&
          typeof value === "object" &&
          Number.isSafeInteger((value as Checkpoint).covered) &&
          (value as Checkpoint).covered >= 0 &&
          typeof (value as Checkpoint).summary === "string"),
    );
  }

  private updateQuota(event: Extract<UiEvent, { type: "usage" }>) {
    const used =
      event.windows?.find((w) => w.windowMinutes === 300)?.usedPercent ??
      event.window5h;
    if (typeof used === "number" && Number.isFinite(used))
      this.quota[event.provider] = used;
    else delete this.quota[event.provider];
  }
  private async record(rt: Runtime, receipt: Receipt) {
    await this.receipts.append(receipt.sessionId, [receipt], this.clean);
    (rt.receipts ??= []).push(receipt);
    this.options.emit({ type: "receipt", receipt });
  }
  private async askPermission(
    session: StoredSession,
    rt: Runtime,
    call: { name: string; input: unknown },
    receiptId: string | undefined,
    signal: AbortSignal,
    forceAsk = false,
    agentName?: string,
    agentId?: string,
  ): Promise<boolean> {
    const previous = rt.permissionTail ?? Promise.resolve();
    let release!: () => void;
    rt.permissionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      if (signal.aborted) return false;
      return await this.askPermissionNow(
        session,
        rt,
        call,
        receiptId,
        signal,
        forceAsk,
        agentName,
        agentId,
      );
    } finally {
      release();
    }
  }

  private async askPermissionNow(
    session: StoredSession,
    rt: Runtime,
    call: { name: string; input: unknown },
    receiptId: string | undefined,
    signal: AbortSignal,
    forceAsk: boolean,
    agentName?: string,
    agentId?: string,
  ): Promise<boolean> {
    const fullCall = { ...call, id: "permission" };
    rt.asked = false;
    if (rt.config) {
      const latest = this.sessions.get(session.id) ?? session;
      const decision = await decidePermission(
        fullCall,
        {
          ...rt.config.permissions,
          mode: latest.permissionMode ?? rt.config.permissions.mode,
        },
        session.cwd,
        {
          readOnly: latest.readOnly,
          scratch: !latest.workspaceId,
          sessionRules: rt.sessionRules,
        },
      );
      if (decision === "deny") return false;
      if (decision === "allow" && !forceAsk) return true;
    } else if (!forceAsk && rt.always.has(call.name)) return true;
    const requestId = randomUUID().slice(0, 8);
    rt.asked = true;
    rt.status = "ask";
    this.options.emit({
      type: "permission_request",
      agentId,
      ...(call.name === "SubmitPlan"
        ? {
            plan: safeInput(
              (call.input as { items: PlanItem[] }).items.map((item) => ({
                ...item,
                assignee: {
                  ...item.assignee,
                  model:
                    resolveModel(
                      item.assignee.model,
                      rt.mainConfig?.aliases ?? this.options.aliases,
                    )?.model ?? item.assignee.model,
                },
              })),
              this.clean,
            ) as unknown[],
          }
        : {}),
      sessionId: session.id,
      requestId,
      receiptId,
      tool: call.name,
      summary:
        (agentName ? `${agentName} · ` : "") +
        (["SubmitPlan", "ProjectHooks"].includes(call.name)
          ? this.clean(JSON.stringify(call.input))
          : summarizeInput(call.name, call.input, this.clean, 300)),
    });
    void this.emitState();
    const decision = await new Promise<PermissionDecision>(
      (resolveDecision) => {
        const done = (d: PermissionDecision) => {
          signal.removeEventListener("abort", onAbort);
          rt.pending = undefined;
          resolveDecision(d);
        };
        const onAbort = () => done("deny");
        rt.pending = {
          requestId,
          resolve: done,
          ...(call.name === "SubmitPlan"
            ? { plan: (call.input as { items: PlanItem[] }).items }
            : {}),
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },
    );
    rt.status = "running";
    if (forceAsk) {
      /* Approval is always per request; never persist it. */
    } else if (decision === "always" && rt.config) {
      const grant = grantFor({
        ...fullCall,
        input: safeInput(fullCall.input, this.clean),
      });
      await saveRule(this.options.home, grant);
      rt.config.permissions.rules.push(grant);
    } else if (decision === "session" && rt.config)
      (rt.sessionRules ??= []).push(grantFor(fullCall));
    else if (decision === "always" || decision === "session")
      rt.always.add(call.name);
    this.options.emit({
      type: "permission_resolved",
      sessionId: session.id,
      requestId,
      decision,
    });
    void this.emitState();
    return decision !== "deny";
  }
}

/** 作業フォルダが無い(またはフォルダでない)ときの通知文。問題が無ければ undefined。 */
async function missingDirectory(path: string): Promise<string | undefined> {
  try {
    if ((await stat(path)).isDirectory()) return undefined;
  } catch {
    /* 見つからない */
  }
  return `作業フォルダが見つかりません: ${path}(フォルダを戻すか、新しいセッションを作成してください)`;
}

function safeInput(input: unknown, clean: (s: string) => string): unknown {
  try {
    return JSON.parse(clean(JSON.stringify(input) ?? "null"));
  } catch {
    return clean(String(input));
  }
}

function toReceipt(r: LoopReceipt, sessionId: string, id: string): Receipt {
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
    tool: r.tool,
    decision: isTool ? (r.decision === "error" ? "deny" : "allow") : undefined,
    durationMs,
    usage: r.usage && {
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
    },
    summary:
      r.provider === "hook"
        ? `hook ${r.timing}:${r.step} → ${r.tool ?? "workflow"} ${r.decision}`
        : `${r.tool ?? r.model}: ${r.decision}`,
  };
}

export function defaultTools(cwd: string, readOnly: boolean): ToolRegistry {
  const access = new FileAccess(cwd);
  const all = new Map([...fileTools(access), ...shellSearchTools(cwd)]);
  if (!readOnly) return all;
  // 読み取り専用で開いたセッションは plan 相当: 書き込み系ツールを渡さない(§9.1, §18.2)
  return new Map([...all].filter(([, tool]) => tool.readOnly));
}
