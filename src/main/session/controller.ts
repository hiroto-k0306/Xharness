import { randomUUID } from "node:crypto";
import { SessionSchedules } from "./schedules.js";
import { readLlmCalls } from "./llm-calls.js";
import {
  attachmentInfo,
  sessionImageBytes,
  DEFAULT_IMAGES,
  IMAGE_ERROR,
  type ImageAttachment,
} from "../../shared/images.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isEffort, loadMainConfig, resolveModel } from "../config/config.js";
import { loadModelCatalog } from "../config/model-catalog.js";
import { loadProjectConfig } from "../config/project.js";
import { WorkspaceTrust } from "../config/trust.js";
import { redact } from "../core/redact.js";
import { validatePlan, type PlanItem } from "../workflow/plan-validate.js";
import {
  type AppState,
  type CommandResult,
  type Effort,
  type HarnessCommand,
  type Receipt,
} from "../../shared/ipc.js";
import {
  createRuntime,
  missingDirectory,
  type ControllerContext,
  type ControllerOptions,
  type Runtime,
} from "./context.js";
import { PermissionGate } from "./permission-gate.js";
import { ReceiptStore } from "./receipts.js";
import { Repository } from "./repository.js";
import { compactNow, saveDefaultModel, setMode } from "./settings-commands.js";
import { SessionStore, WorkspaceStore, type StoredSession } from "./store.js";
import { itemsFromMessages } from "./transcript.js";
import { runMcpCommand, runSessionTurn } from "./turn.js";
import { runRewind } from "./rewind-command.js";
import { rewindTurns, parseRewindChoice } from "../../shared/rewind.js";
import { FileCheckpointStore } from "../checkpoints/store.js";
import {
  finishWorktree,
  RepositoryOpener,
  restoreWorktree,
} from "./worktree-commands.js";
import { emitMcpState, MCP_COMMAND } from "./mcp-session.js";
import { exportExecutionReport } from "./report.js";
import {
  costSummary,
  expandCommand,
  initAgents,
  userCommands,
} from "./slash-commands.js";

export { defaultTools } from "./context.js";
export type { ControllerOptions, Host } from "./context.js";

/**
 * セッション全体の窓口。electron を import しない。UI(renderer)とは UiEvent / HarnessCommand だけで話す。
 *
 * 実際の処理は次のモジュールに分けている:
 * - context.ts            共有の型(Runtime など)と小さな関数
 * - turn.ts               1ターンの実行と保存
 * - turn-events.ts        Agent Loop のイベント → 画面イベント・レシート
 * - workflow-factory.ts   タスク段階(WorkflowRuntime)の組み立て
 * - permission-gate.ts    権限確認(STEP 4)
 * - worktree-commands.ts  repository / worktree の操作
 * - settings-commands.ts  権限モード・既定モデル・/compact
 */
export class SessionController {
  private readonly schedules: SessionSchedules;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly sessions: SessionStore;
  private readonly workspaces: WorkspaceStore;
  private readonly ctx: ControllerContext;
  private readonly gate: PermissionGate;
  private readonly repositories: RepositoryOpener;
  private current: string | null = null;
  private model: string;
  private effort: Effort;
  private warnings: string[];
  private stopped = false;
  private gitAvailable = true;
  private commands: NonNullable<AppState["commands"]> = [];
  private imageSettings = { ...DEFAULT_IMAGES };

  constructor(private readonly options: ControllerOptions) {
    this.schedules = new SessionSchedules({
      now: () => Date.now(),
      busy: (id) =>
        this.ctx.sessionBusy.has(id) ||
        (this.runtimes.get(id)?.status ?? "idle") !== "idle",
      send: (id, text, signal) => this.send(id, text, undefined, signal),
      notice: (sessionId, message) =>
        this.options.emit({
          type: "notice",
          sessionId,
          message: this.ctx.clean(message),
          tone: "dim",
        }),
    });
    const emit = options.emit;
    options = {
      ...options,
      emit: (event) => {
        emit(event);
        if (
          event.type === "turn" &&
          event.status === "idle" &&
          event.stopCause
        ) {
          if (
            ["end_turn", "workflow_complete", "reported_done"].includes(
              event.stopCause,
            )
          )
            this.schedules.idle(event.sessionId);
          else this.schedules.cancel(event.sessionId);
        }
      },
    };
    this.options = options;
    this.sessions = new SessionStore(options.home);
    this.workspaces = new WorkspaceStore(options.home);
    this.model = options.model;
    this.effort = options.effort ?? "high";
    this.warnings = [...(options.warnings ?? [])];
    const receipts = new ReceiptStore(options.home);
    const clean = (text: string) => redact(text, options.secrets ?? []);
    this.ctx = {
      options,
      sessions: this.sessions,
      receipts,
      workspaces: this.workspaces,
      repository: new Repository(options.home),
      trust: new WorkspaceTrust(options.home),
      quota: {},
      usage: {},
      worktreeBusy: new Set(),
      sessionBusy: new Set(),
      clean,
      runtime: (id) => this.runtime(id),
      existingRuntime: (id) => this.runtimes.get(id),
      dropRuntime: (id) => {
        // MCP サーバーのプロセスもセッションと一緒に止める(§25.3)
        void this.runtimes.get(id)?.mcp?.close();
        this.runtimes.delete(id);
      },
      load: (id) => this.load(id),
      emitState: () => this.emitState(),
      refreshCommands: () => this.refreshCommands(),
      record: async (rt, receipt: Receipt) => {
        await receipts.append(receipt.sessionId, [receipt], clean);
        (rt.receipts ??= []).push(receipt);
        options.emit({ type: "receipt", receipt });
      },
      workspaceRoot: (session) =>
        session.workspaceId
          ? this.workspaces.get(session.workspaceId)?.root
          : undefined,
    };
    this.gate = new PermissionGate(this.ctx);
    this.repositories = new RepositoryOpener(this.ctx);
  }

  async init() {
    this.imageSettings = (await loadMainConfig(this.options.home)).images;
    if (!this.options.fake) await this.options.authentication?.refresh();
    await Promise.all([this.sessions.load(), this.workspaces.load()]);
    this.sessions.fillDefaults({ model: this.model, effort: this.effort });
    await new FileCheckpointStore(this.options.home).purge(
      (await loadProjectConfig(this.options.home)).checkpoints?.retentionDays ??
        30,
      Date.now(),
      true,
    );
    if (this.options.phase4) {
      this.gitAvailable = await this.ctx.repository.available();
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
      rt = createRuntime();
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
        this.ctx.receipts.read(id),
        readLlmCalls(this.options.home, id).catch(() => undefined),
      ]).then(([messages, receipts, calls]) => {
        if (rt.loaded) return;
        rt.messages = messages;
        rt.llmCalls = calls;
        rt.persisted = messages.length;
        rt.loaded = true;
        rt.receipts = receipts;
        rt.receiptSeq = Math.max(
          0,
          ...receipts.map((r) => Number(r.id.slice(1)) || 0),
        );
      });
    if (!rt.loaded) await rt.loading;
    for (const warning of this.sessions.warnings.splice(0))
      this.warnings.push(warning);
    return rt;
  }

  async state(): Promise<AppState> {
    const workspaces = await this.workspaces.summaries();
    const branch = new Map(workspaces.map((w) => [w.id, w.branch]));
    return {
      commands: this.commands,
      images: this.imageSettings,
      authentication: this.options.fake
        ? undefined
        : this.options.authentication?.snapshot(),
      models: loadModelCatalog()
        .filter((m) => m.enabled)
        .map((m) => ({
          id: m.id,
          provider: m.provider,
          label: (m as typeof m & { displayName?: string }).displayName ?? m.id,
          imageInput: m.imageInput,
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
        llmCalls: this.runtimes.get(s.id)?.llmCalls,
        imageBytes: sessionImageBytes(this.runtimes.get(s.id)?.messages),
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
  private async refreshCommands() {
    const id = this.current;
    const active = id ? this.sessions.get(id) : undefined;
    const root = active && this.ctx.workspaceRoot(active);
    const commands = await userCommands(
      this.options.home,
      active?.cwd,
      !!active &&
        (!root ||
          !!this.runtimes.get(active.id)?.trustedSession ||
          (await this.ctx.trust.isTrusted(root))),
    );
    if (this.current === id)
      this.commands = commands.map((c) => ({
        value: `/${c.name}`,
        args: "[arguments]",
        description:
          c.source === "project" ? "プロジェクト定義" : "ユーザー定義",
      }));
  }

  async handle(command: HarnessCommand): Promise<CommandResult> {
    try {
      switch (command.type) {
        case "rewind_response": {
          const rt = this.runtimes.get(command.sessionId);
          if (
            !rt?.rewindPrompt ||
            rt.rewindPrompt.requestId !== command.requestId
          )
            return { ok: false, error: "復元の確認が見つかりません。" };
          const choice =
            command.choice === null ? null : parseRewindChoice(command.choice);
          if (choice === undefined)
            return { ok: false, error: "復元の指定が不正です。" };
          rt.rewindPrompt.resolve(choice);
          return { ok: true };
        }
        case "delete_session": {
          if (
            !command.confirmed ||
            !this.sessions.get(command.sessionId) ||
            this.ctx.sessionBusy.has(command.sessionId) ||
            (this.runtimes.get(command.sessionId)?.status !== "idle" &&
              this.runtimes.has(command.sessionId))
          )
            return {
              ok: false,
              error: "待機中のセッションを確認して削除してください。",
            };
          this.ctx.sessionBusy.add(command.sessionId);
          try {
            this.schedules.cancel(command.sessionId);
            await this.sessions.delete(command.sessionId);
            this.ctx.dropRuntime(command.sessionId);
            if (this.current === command.sessionId) {
              this.current = null;
              this.commands = [];
            }
            await this.emitState();
            return { ok: true };
          } finally {
            this.ctx.sessionBusy.delete(command.sessionId);
          }
        }
        case "refresh_auth":
          if (!this.options.fake) await this.options.authentication?.refresh();
          await this.emitState();
          return { ok: true };
        case "authenticate":
          if (this.stopped) return { ok: false, error: "Shutting down" };
          if (this.options.fake || !this.options.authentication)
            return { ok: false, error: "この起動では認証操作を利用できません" };
          if ([...this.runtimes.values()].some((rt) => rt.status !== "idle"))
            return {
              ok: false,
              error: "すべての実行が終了してから認証してください",
            };
          await this.options.authentication.authenticate(command.provider);
          await this.emitState();
          return { ok: true };
        case "restore_worktree":
          return await restoreWorktree(this.ctx, command);
        case "open_repository":
          return await this.repositories.open(command);
        case "finish_worktree":
          return await finishWorktree(this.ctx, command);
        case "abort_repository":
          this.repositories.abort();
          return { ok: true };
        case "set_mode":
          return await setMode(this.ctx, command);
        case "ready": {
          await this.refreshCommands();
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
          await this.refreshCommands();
          await this.emitTranscript(command.sessionId);
          await this.emitState();
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
        case "export_report": {
          if (!this.sessions.get(command.sessionId))
            return { ok: false, error: "Unknown session" };
          const rt = this.runtimes.get(command.sessionId);
          if (rt && rt.status !== "idle")
            return {
              ok: false,
              error: "実行終了後にレポートを出力してください",
            };
          const path = await this.options.host.saveReport?.(
            `xharness-${command.sessionId}-${Date.now()}.html`,
          );
          if (!path) return { ok: false, error: "cancelled" };
          // A turn may start while the native save dialog is open.
          const currentRuntime = this.runtimes.get(command.sessionId);
          if (currentRuntime && currentRuntime.status !== "idle")
            return {
              ok: false,
              error: "実行終了後にレポートを出力してください",
            };
          await exportExecutionReport(
            this.options.home,
            command.sessionId,
            path,
            this.ctx.clean,
          );
          return { ok: true };
        }
        case "send":
          return this.send(command.sessionId, command.text, command.images);
        case "abort": {
          this.schedules.cancel(command.sessionId);
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
          const saved = await saveDefaultModel(this.options.home, command);
          if (!saved.ok) return saved;
          if (!this.options.cliModel) this.model = command.model;
          if (!this.options.cliEffort) this.effort = saved.effort;
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
      if (this.ctx.worktreeBusy.has(cwd))
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
        ? await this.ctx.repository.createWorktree(
            cwd,
            workspaceId,
            id,
            new AbortController().signal,
            baseBranch,
            newBranch,
          )
        : undefined;
    if (worktree) cwd = worktree.path;
    const root = workspaceId
      ? this.workspaces.get(workspaceId)?.root
      : undefined;
    const projectMain =
      this.options.phase4 && workspaceId && !this.options.fake
        ? await loadMainConfig(this.options.home, undefined, root)
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
                  await loadProjectConfig(this.options.home, root, {
                    trusted: !root || (await this.ctx.trust.isTrusted(root)),
                  })
                ).permissions.mode,
          }
        : {}),
    };
    await this.sessions.save(session);
    this.runtime(id).loaded = true;
    this.current = id;
    await this.refreshCommands();
    this.options.emit({ type: "transcript", sessionId: id, items: [] });
    await this.emitState();
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

  private async send(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    scheduled?: AbortSignal,
  ): Promise<CommandResult> {
    // Stop must remain usable while preparation/compact is awaiting I/O.
    if (
      /^(?:\/stop|(?:一旦)?(?:停止|中断)(?:して)?|止めて)[。！!]?$/u.test(
        text.trim(),
      )
    )
      return this.sendPrepared(sessionId, text, images, scheduled);
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Unknown session" };
    const root = this.ctx.workspaceRoot(session);
    if (root && this.ctx.worktreeBusy.has(root))
      return { ok: false, error: "Workspace writer busy" };
    if (this.ctx.sessionBusy.has(sessionId))
      return { ok: false, error: "Turn already running" };
    this.ctx.sessionBusy.add(sessionId);
    try {
      return await this.sendPrepared(sessionId, text, images, scheduled);
    } finally {
      this.ctx.sessionBusy.delete(sessionId);
    }
  }

  private async sendPrepared(
    sessionId: string,
    text: string,
    images?: ImageAttachment[],
    scheduled?: AbortSignal,
  ): Promise<CommandResult> {
    const imageSettings = (await loadMainConfig(this.options.home)).images;
    this.imageSettings = imageSettings;
    if (scheduled?.aborted)
      return { ok: false, error: "予約を取り消しました。" };
    if ((images?.length ?? 0) > imageSettings.maxPerMessage)
      return {
        ok: false,
        error: `画像の添付は1メッセージ${imageSettings.maxPerMessage}枚までです。`,
      };
    try {
      images?.forEach(attachmentInfo);
    } catch {
      return { ok: false, error: IMAGE_ERROR };
    }
    if (images?.length && text.trim().startsWith("/"))
      return {
        ok: false,
        error: "画像は通常のメッセージと一緒に送信してください。",
      };
    if (
      /^(?:\/stop|(?:一旦)?(?:停止|中断)(?:して)?|止めて)[。！!]?$/u.test(
        text.trim(),
      )
    ) {
      if (!this.sessions.get(sessionId))
        return { ok: false, error: "Unknown session" };
      const rt = this.runtimes.get(sessionId);
      this.schedules.cancel(sessionId);
      if (rt) this.release(rt);
      this.options.emit({
        type: "notice",
        sessionId,
        tone: "dim",
        message: "停止しました。再開するときは新しい指示を入力してください。",
      });
      return { ok: true };
    }
    if (!this.options.fake && this.options.authentication?.isBusy())
      return { ok: false, error: "認証完了後に送信してください" };
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Unknown session" };
    if (this.stopped) return { ok: false, error: "Shutting down" };
    const root = this.ctx.workspaceRoot(session);
    if (root && this.ctx.worktreeBusy.has(root))
      return { ok: false, error: "Workspace writer busy" };
    const command = text.trim();
    if (/^\/(?:schedule|signal)(?:\s|$)/.test(command))
      return this.schedules.command(sessionId, command);
    const notice = (message: string): CommandResult => {
      this.options.emit({
        type: "notice",
        sessionId,
        tone: "dim",
        message: this.ctx.clean(message),
      });
      return { ok: true };
    };
    if (/^\/(?:clear|resume|cost|init)(?:\s|$)/.test(command)) {
      const [name, argument, extra] = command.split(/\s+/);
      const rt = await this.load(sessionId);
      if (rt.status !== "idle")
        return { ok: false, error: "実行終了後にコマンドを使用してください。" };
      if (extra || (name !== "/resume" && argument))
        return { ok: false, error: "コマンドの引数を確認してください。" };
      if (name === "/clear")
        return this.newSession(
          session.workspaceId,
          session.readOnly,
          !!session.worktree,
        );
      if (name === "/resume") {
        if (argument)
          return this.handle({ type: "open_session", sessionId: argument });
        return notice(
          "再開する会話（/resume <sessionId>）：\n" +
            this.sessions
              .list()
              .map((s) => `${s.id} · ${s.title}`)
              .join("\n"),
        );
      }
      if (name === "/cost")
        return notice(
          costSummary(
            await readLlmCalls(this.options.home, sessionId),
            rt.receipts ?? [],
          ),
        );
      if (this.otherWriterRunning(session))
        return { ok: false, error: "Workspace writer busy" };
      rt.status = "running";
      try {
        const config = await loadProjectConfig(this.options.home, root, {
          trusted:
            !root ||
            !!rt.trustedSession ||
            (await this.ctx.trust.isTrusted(root)),
        });
        const result = await initAgents(
          session.cwd,
          session.readOnly ||
            (session.permissionMode ?? config.permissions.mode) === "plan",
        );
        if (result.ok)
          notice(
            "AGENTS.mdの雛形を作成しました。プロジェクトに合わせて編集してください。",
          );
        return result;
      } finally {
        rt.status = "idle";
      }
    }
    if (/^\/mode(?:\s|$)/.test(command)) {
      const [, mode, extra] = command.split(/\s+/);
      if (extra || !["default", "acceptEdits", "plan"].includes(mode ?? ""))
        return { ok: false, error: "Usage: /mode default|acceptEdits|plan" };
      return setMode(this.ctx, {
        type: "set_mode",
        sessionId,
        mode: mode as "default" | "acceptEdits" | "plan",
      });
    }
    if (command === "/compact")
      return this.authenticationRequired(session)
        ? {
            ok: false,
            error:
              "認証欄で公式CLIの認証・更新を許可してから再送信してください",
          }
        : compactNow(this.ctx, sessionId);
    if (/^\/model(?:\s|$)/.test(command)) {
      const [, model, effort, extra] = command.split(/\s+/);
      if (!model)
        return notice(
          "モデル（/model <provider:model> [effort]）：\n" +
            loadModelCatalog()
              .filter((m) => m.enabled)
              .map((m) => m.id)
              .join("\n"),
        );
      if (!model || extra || (effort !== undefined && !isEffort(effort)))
        return { ok: false, error: "Usage: /model provider:model [effort]" };
      return this.setModel(sessionId, model, effort as Effort | undefined);
    }
    const rt = await this.load(sessionId);
    // Another session's worktree operation can claim the root while history
    // loads. Our own session reservation prevents same-session deletion.
    if (root && this.ctx.worktreeBusy.has(root))
      return { ok: false, error: "Workspace writer busy" };
    if (/^\/(?:undo|rewind)(?:\s|$)/.test(command)) {
      const count = rewindTurns(command);
      if (!count)
        return { ok: false, error: "使い方：/undo または /rewind <正の整数>" };
      if (rt.status !== "idle" || this.otherWriterRunning(session))
        return {
          ok: false,
          error: "書き込み処理の終了後に巻き戻してください。",
        };
      rt.status = "running";
      rt.closing = false;
      rt.done = runRewind(this.ctx, session, rt, count);
      return { ok: true, sessionId };
    }
    if (MCP_COMMAND.test(command)) {
      // /mcp はモデルに送らない。状態の表示は実行中でもできるが、操作は待機中だけ(§25.8)
      if (rt.status !== "idle") {
        if (command !== "/mcp")
          return { ok: false, error: "Turn already running" };
        emitMcpState(this.ctx, session, rt, true);
        return { ok: true };
      }
      rt.status = "running";
      rt.closing = false;
      rt.done = runMcpCommand(this.ctx, this.gate, session, rt, command).catch(
        () => undefined,
      );
      return { ok: true, sessionId };
    }
    const phaseCommand = /^\/(?:phase|review)(?:\s|$)/.test(command);
    if (rt.status !== "idle") {
      if (phaseCommand && rt.workflow) {
        const [name, phase, extra] = command.split(/\s+/);
        if (extra || (name === "/review" && phase))
          return { ok: false, error: "Invalid phase command" };
        rt.workflow.queuePhase(name === "/review" ? "review" : (phase ?? ""));
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
    if (phaseCommand) {
      const [name, phase, extra] = command.split(/\s+/);
      if (!rt.workflow || extra || (name === "/review" && phase))
        return { ok: false, error: "No workflow or invalid phase command" };
      const requested = name === "/review" ? "review" : (phase ?? "");
      rt.workflow.manualPhase(requested);
      if (requested !== "review") return { ok: true };
    }
    if (this.otherWriterRunning(session)) {
      this.options.emit({
        type: "error",
        sessionId,
        message:
          "同じワークスペースで書き込みセッションが実行中です。読み取り専用か worktree を使ってください",
      });
      return { ok: false, error: "Workspace writer busy" };
    }
    // 確認より前に同期的に予約する(次の await の間に届いた二重送信を弾く)
    if (this.authenticationRequired(session))
      return {
        ok: false,
        error: "認証欄で公式CLIの認証・更新を許可してから再送信してください",
      };
    if (scheduled?.aborted)
      return { ok: false, error: "予約を取り消しました。" };
    rt.status = "running";
    rt.closing = false;
    const abort = new AbortController();
    const cancelScheduled = () => abort.abort();
    scheduled?.addEventListener("abort", cancelScheduled, { once: true });
    rt.abort = abort;
    let finish!: () => void;
    rt.done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let launched = false;
    this.options.emit({ type: "turn", sessionId, status: "running" });
    // Resolve user definitions once. The expansion is a user message, never a second command.
    try {
      const expanded = expandCommand(
        text,
        await userCommands(
          this.options.home,
          session.cwd,
          !root ||
            !!rt.trustedSession ||
            (await this.ctx.trust.isTrusted(root)),
        ),
      );
      abort.signal.throwIfAborted();
      if (expanded !== undefined) text = expanded;
      else if (
        /^\/[\p{L}\p{N}_-]+(?:\s|$)/u.test(command) &&
        !phaseCommand &&
        !command.startsWith("/mcp__")
      ) {
        return {
          ok: false,
          error: "コマンドが見つからないか、プロジェクトが未信頼です。",
        };
      }
      // The reservation covers preparation too, so stop/close/shutdown can cancel it.
      if (await this.reportMissingCwd(session))
        return { ok: false, error: "Working directory not found" };
      abort.signal.throwIfAborted();
      launched = true;
      void runSessionTurn(this.ctx, this.gate, session, rt, text, images, abort)
        .catch(() => undefined)
        .finally(() => {
          scheduled?.removeEventListener("abort", cancelScheduled);
          finish();
        });
      return { ok: true, sessionId };
    } catch {
      return {
        ok: false,
        error: abort.signal.aborted
          ? "送信を中断しました。"
          : "ユーザー定義コマンドを読み込めませんでした。",
      };
    } finally {
      if (!launched) {
        scheduled?.removeEventListener("abort", cancelScheduled);
        rt.status = "idle";
        rt.abort = undefined;
        this.options.emit({
          type: "turn",
          sessionId,
          status: "idle",
          ...(abort.signal.aborted ? { stopCause: "aborted" } : {}),
        });
        if (rt.closing) this.ctx.dropRuntime(sessionId);
        finish();
        await this.emitState();
      }
    }
  }

  private authenticationRequired(session: StoredSession) {
    if (this.options.fake || !this.options.authentication) return false;
    const provider = resolveModel(
      session.model,
      this.runtimes.get(session.id)?.mainConfig?.aliases ??
        this.options.aliases,
    )?.provider;
    const auth = this.options.authentication
      .snapshot()
      .find((v) => v.provider === provider);
    return !!auth && auth.status !== "available";
  }

  /** §18.3: worktree を使わない書き込みセッションは、同じワークスペースで同時に1つまで */
  private otherWriterRunning(session: StoredSession): boolean {
    if (session.readOnly || session.worktree || !session.workspaceId)
      return false;
    return this.sessions
      .list()
      .some(
        (other) =>
          other.id !== session.id &&
          other.workspaceId === session.workspaceId &&
          !other.readOnly &&
          !other.worktree &&
          (this.ctx.sessionBusy.has(other.id) ||
            (this.runtimes.get(other.id)?.status ?? "idle") !== "idle"),
      );
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
          this.ctx.workspaceRoot(session),
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
    this.schedules.cancel(sessionId);
    if (!this.sessions.get(sessionId))
      return { ok: false, error: "Unknown session" };
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.closing = true;
      this.release(rt);
      if (rt.status === "idle") this.ctx.dropRuntime(sessionId);
    }
    if (this.current === sessionId) {
      this.current = null;
      this.commands = [];
    }
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
    this.schedules.close();
    this.repositories.abort();
    const running: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) {
      this.release(rt);
      if (rt.done) running.push(rt.done);
    }
    await Promise.race([
      Promise.all(running),
      new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.()),
    ]);
    await Promise.race([
      Promise.all([...this.runtimes.values()].map((rt) => rt.mcp?.close())),
      new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.()),
    ]);
  }
}
