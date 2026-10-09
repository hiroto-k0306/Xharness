import { randomUUID } from "node:crypto";
import { isConnectionChoice } from "../../shared/connections.js";
import { unavailableConnections } from "../connections/ui-registry.js";
import { QuotaPauses, type QuotaPause } from "./quota-pause.js";
import { ProjectMemory } from "./project-memory.js";
import { Handoffs, HandoffFault } from "./handoffs.js";
import {
  LocalBrowserSessions,
  LocalBrowserFault,
} from "../computer-use/session.js";
import { CandidateQuotas } from "./candidate-quota.js";
import { readSkillUi } from "./skill-ui.js";
import { officialSkillUi } from "./official-skill-ui.js";
import { decidePermission } from "../core/permissions.js";
import { captureQuotaPause } from "./quota-capture.js";
import { resumeConditions, resumeHash } from "./resume-conditions.js";
import { checkpointFile } from "./context.js";
import { readLlmCalls } from "./llm-calls.js";
import {
  sessionImageBytes,
  DEFAULT_IMAGES,
  type ImageAttachment,
} from "../../shared/images.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isEffort, loadMainConfig, resolveModel } from "../config/config.js";
import { loadModelCatalog } from "../config/model-catalog.js";
import { resolveModelPolicy } from "../config/catalog.js";
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
import { saveDefaultModel, setMode } from "./settings-commands.js";
import {
  SessionStore,
  WorkspaceStore,
  RECOVERY_NOTICE,
  type StoredSession,
} from "./store.js";
import { itemsFromMessages } from "./transcript.js";
import { runSessionTurn, runOfficialSessionTurn } from "./turn.js";
import { parseRewindChoice } from "../../shared/rewind.js";
import { FileCheckpointStore } from "../checkpoints/store.js";
import {
  finishWorktree,
  RepositoryOpener,
  restoreWorktree,
} from "./worktree-commands.js";
import { exportExecutionReport } from "./report.js";
import { userCommands } from "./slash-commands.js";

export { defaultTools } from "./context.js";
export type { ControllerOptions, Host } from "./context.js";

/**
 * セッション全体の窓口。electron を import しない。UI(renderer)とは UiEvent / HarnessCommand だけで話す。
 *
 * 実際の処理は次のモジュールに分けている:
 * - context.ts            共有の型(Runtime など)と小さな関数
 * - turn.ts               1ターンの実行と保存
 * - turn-events.ts        Agent Loop のイベント → 画面イベント・レシート
 * - permission-gate.ts    権限確認(STEP 4)
 * - worktree-commands.ts  repository / worktree の操作
 * - settings-commands.ts  権限モード・既定モデル・/compact
 */
export class SessionController {
  private connectionCheck?: { sessionId: string; abort: AbortController };
  private readonly localBrowser: LocalBrowserSessions;
  private readonly browserJobs = new Map<string, AbortController>();
  private readonly handoffs: Handoffs;
  private readonly handoffBusy = new Set<string>();
  private readonly skillReads = new Map<
    string,
    { requestId: string; abort: AbortController }
  >();
  private readonly quotaPauses: QuotaPauses;
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
  private readonly preparations = new Map<
    string,
    {
      abort: AbortController;
      done: Promise<void>;
    }
  >();
  private gitAvailable = true;
  private commands: NonNullable<AppState["commands"]> = [];
  private imageSettings = { ...DEFAULT_IMAGES };

  constructor(private readonly options: ControllerOptions) {
    this.localBrowser = new LocalBrowserSessions(
      options.localBrowserFactory,
      Date.now,
      options.localBrowserTimeoutMs,
    );
    this.handoffs = new Handoffs(options.home);
    this.sessions = new SessionStore(options.home);
    this.workspaces = new WorkspaceStore(options.home);
    this.model = options.model;
    this.effort = options.effort ?? "high";
    this.warnings = [...(options.warnings ?? [])];
    const receipts = new ReceiptStore(options.home);
    const clean = (text: string) => redact(text, options.secrets ?? []);
    this.ctx = {
      quotaPaused: (session, rt, evidence) =>
        captureQuotaPause(this.ctx, this.quotaPauses, session, rt, evidence),
      options,
      sessions: this.sessions,
      receipts,
      workspaces: this.workspaces,
      repository: new Repository(options.home),
      trust: new WorkspaceTrust(options.home),
      quota: {},
      usage: {},
      candidateQuotas: new CandidateQuotas(),
      worktreeBusy: new Set(),
      sessionBusy: new Set(),
      clean,
      runtime: (id) => this.runtime(id),
      existingRuntime: (id) => this.runtimes.get(id),
      dropRuntime: (id) => {
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
    this.quotaPauses = new QuotaPauses({
      home: options.home,
      now: options.quotaNow ?? Date.now,
      timers: options.quotaTimers,
      changed: () => this.emitState(),
      busy: (id) =>
        this.ctx.sessionBusy.has(id) ||
        (this.runtimes.get(id)?.status ?? "idle") !== "idle",
      resume: (pause, signal) => this.resumeQuota(pause, signal),
    });
  }

  async init() {
    this.imageSettings = (await loadMainConfig(this.options.home)).images;
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
    await this.quotaPauses.load();
    this.warnings.push(...this.quotaPauses.warnings);
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
      officialDefault: !!this.options.officialSession,
      commands: this.commands,
      ...(this.options.connections
        ? { connections: this.options.connections.views() }
        : {}),
      images: this.imageSettings,
      models: loadModelCatalog()
        .filter((m) => m.enabled)
        .map((m) => ({
          id: m.id,
          alias: m.alias,
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
        quotaPause: this.quotaPauses.view(s.id),
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
    // Stale direct callers cannot reactivate retired comparison operations.
    if ((command as { type: string }).type === "improvements")
      return {
        ok: false,
        error:
          "手動改善版の比較・採用機能は廃止されました。既存の比較データは変更していません。",
      };
    if (this.stopped) return { ok: false, error: "アプリ終了処理中です。" };
    try {
      switch (command.type) {
        case "local_browser": {
          const session = this.sessions.get(command.sessionId);
          if (!session || this.stopped)
            return { ok: false, error: "Session unavailable" };
          if (command.request.action === "stop") {
            this.browserJobs.get(session.id)?.abort();
            return {
              ok: true,
              localBrowser: await this.localBrowser.run(
                {
                  home: this.options.home,
                  sessions: this.sessions,
                  workspaces: this.workspaces,
                  sessionId: session.id,
                  workspaceId: session.workspaceId,
                  cwd: session.cwd,
                  clean: this.ctx.clean,
                },
                command.request,
                async () => {},
                (receipt) => this.ctx.record(this.runtime(session.id), receipt),
              ),
            };
          }
          const rt = this.runtime(session.id);
          if (this.ctx.sessionBusy.has(session.id) || rt.status !== "idle")
            return {
              ok: false,
              error: "会話の実行終了後にローカル観測を確認してください。",
            };
          const abort = new AbortController();
          this.browserJobs.set(session.id, abort);
          this.ctx.sessionBusy.add(session.id);
          rt.abort = abort;
          rt.status = "running";
          const job = (async () => {
            try {
              await this.load(session.id);
              await this.emitState();
              abort.signal.throwIfAborted();
              const localBrowser = await this.localBrowser.run(
                {
                  home: this.options.home,
                  sessions: this.sessions,
                  workspaces: this.workspaces,
                  sessionId: session.id,
                  workspaceId: session.workspaceId,
                  cwd: session.cwd,
                  clean: this.ctx.clean,
                },
                command.request,
                async (tool) => {
                  const current = this.sessions.get(session.id),
                    root =
                      current?.workspaceId &&
                      this.workspaces.get(current.workspaceId)?.root;
                  if (!current || abort.signal.aborted || this.stopped)
                    throw new LocalBrowserFault("停止・取消しました。");
                  const config = await loadProjectConfig(
                    this.options.home,
                    root || undefined,
                    {
                      trusted: !root || (await this.ctx.trust.isTrusted(root)),
                    },
                  );
                  if (
                    (await decidePermission(
                      {
                        id: "local-browser-ui",
                        name: tool,
                        input: command.request,
                      },
                      {
                        ...config.permissions,
                        mode: current.permissionMode ?? config.permissions.mode,
                      },
                      current.cwd,
                      { readOnly: current.readOnly },
                    )) === "deny"
                  )
                    throw new LocalBrowserFault(
                      "現在の権限ではこの観測・操作を許可できません。",
                    );
                },
                (receipt) => this.ctx.record(rt, receipt),
              );
              return { ok: true as const, localBrowser };
            } catch (error) {
              return {
                ok: false as const,
                error:
                  error instanceof LocalBrowserFault
                    ? error.message
                    : "観測・実行・保存の結果を確認できません。一覧を確認してください。",
              };
            } finally {
              rt.abort = undefined;
              rt.status = "idle";
              this.browserJobs.delete(session.id);
              this.ctx.sessionBusy.delete(session.id);
              await this.emitState();
            }
          })();
          rt.done = job.then(() => undefined);
          return job;
        }
        case "handoffs": {
          const session = this.sessions.get(command.sessionId);
          if (!session || this.stopped)
            return { ok: false, error: "Session unavailable" };
          const held = new Set<string>();
          try {
            const handoffs = await this.handoffs.run(
              {
                home: this.options.home,
                sessions: this.sessions,
                workspaces: this.workspaces,
                sessionId: session.id,
                workspaceId: session.workspaceId,
                cwd: session.cwd,
                clean: this.ctx.clean,
              },
              command.request,
              async (ids) => {
                for (const id of ids) {
                  const target = this.sessions.get(id);
                  if (
                    !target ||
                    this.ctx.sessionBusy.has(id) ||
                    this.runtime(id).status !== "idle"
                  )
                    throw new HandoffFault(
                      "送信元と宛先の実行終了後に確認してください。",
                    );
                  this.ctx.sessionBusy.add(id);
                  this.handoffBusy.add(id);
                  held.add(id);
                }
                for (const id of ids) {
                  const target = this.sessions.get(id)!;
                  const root =
                    target.workspaceId &&
                    this.workspaces.get(target.workspaceId)?.root;
                  const config = await loadProjectConfig(
                    this.options.home,
                    root || undefined,
                    {
                      trusted: !root || (await this.ctx.trust.isTrusted(root)),
                    },
                  );
                  if (
                    this.stopped ||
                    target.permissionMode === "plan" ||
                    (await decidePermission(
                      {
                        id: "handoff-ui",
                        name: "ProposeProjectMemory",
                        input: command.request,
                      },
                      {
                        ...config.permissions,
                        mode: target.permissionMode ?? config.permissions.mode,
                      },
                      target.cwd,
                      { readOnly: target.readOnly },
                    )) === "deny"
                  )
                    throw new HandoffFault(
                      "現在の権限では受け渡しできません。",
                    );
                }
              },
            );
            return { ok: true, handoffs };
          } catch (e) {
            return {
              ok: false,
              error:
                e instanceof HandoffFault
                  ? e.message
                  : "配送状態を確認できません。受信一覧を再取得してください。",
            };
          } finally {
            for (const id of held) {
              this.ctx.sessionBusy.delete(id);
              this.handoffBusy.delete(id);
            }
          }
        }
        case "official_skills": {
          const session = this.sessions.get(command.sessionId);
          if (!session || this.stopped)
            return { ok: false, error: "Session unavailable" };
          const rt = this.runtime(session.id);
          if (this.ctx.sessionBusy.has(session.id) || rt.status !== "idle")
            return {
              ok: false,
              error: "実行終了後に公式スキルを確認してください。",
            };
          const abort = new AbortController();
          this.ctx.sessionBusy.add(session.id);
          rt.abort = abort;
          rt.status = "running";
          const job = (async () => {
            await this.load(session.id);
            return officialSkillUi(
              this.ctx,
              this.gate,
              session,
              rt,
              command.request,
              abort.signal,
            );
          })().finally(async () => {
            this.ctx.sessionBusy.delete(session.id);
            rt.status = "idle";
            rt.abort = undefined;
            await this.emitState();
            if (rt.closing) this.ctx.dropRuntime(session.id);
          });
          rt.done = job.then(
            () => undefined,
            () => undefined,
          );
          return await job;
        }
        case "project_skills": {
          const request = command.request;
          if (request.action === "cancel") {
            const active = this.skillReads.get(command.sessionId);
            if (active?.requestId !== request.requestId)
              return { ok: false, error: "No such skill read" };
            active.abort.abort();
            return { ok: true };
          }
          const session = this.sessions.get(command.sessionId);
          if (!session || this.stopped)
            return { ok: false, error: "Session unavailable" };
          const rt = this.runtime(session.id);
          if (this.ctx.sessionBusy.has(session.id) || rt.status !== "idle")
            return {
              ok: false,
              error: "実行終了後にスキルを確認してください。",
            };
          const abort = new AbortController();
          this.skillReads.set(session.id, {
            requestId: request.requestId,
            abort,
          });
          this.ctx.sessionBusy.add(session.id);
          rt.abort = abort;
          rt.status = "running";
          const job = (async () => {
            await this.load(session.id);
            if (abort.signal.aborted)
              return { ok: false as const, error: "取消しました。" };
            return readSkillUi(
              this.ctx,
              this.gate,
              session,
              rt,
              request,
              abort.signal,
            );
          })().finally(async () => {
            this.skillReads.delete(session.id);
            this.ctx.sessionBusy.delete(session.id);
            rt.status = "idle";
            rt.abort = undefined;
            await this.emitState();
            if (rt.closing) this.ctx.dropRuntime(session.id);
          });
          rt.done = job.then(
            () => undefined,
            () => undefined,
          );
          return await job;
        }
        case "project_memory": {
          const session = this.sessions.get(command.sessionId);
          if (!session || this.stopped)
            return { ok: false, error: "Session unavailable" };
          const memory = new ProjectMemory(
            {
              home: this.options.home,
              sessions: this.sessions,
              workspaces: this.workspaces,
              sessionId: session.id,
              workspaceId: session.workspaceId,
              cwd: session.cwd,
              clean: this.ctx.clean,
            },
            () =>
              this.options.emit({
                type: "memory_changed",
                sessionId: session.id,
              }),
          );
          if (command.request.action === "list")
            return { ok: true, memory: await memory.list() };
          if (
            this.ctx.sessionBusy.has(session.id) ||
            (this.runtimes.get(session.id)?.status ?? "idle") !== "idle"
          )
            return {
              ok: false,
              error: "実行終了後にメモリを確認・編集してください。",
            };
          this.ctx.sessionBusy.add(session.id);
          try {
            const root = this.ctx.workspaceRoot(session);
            const config = await loadProjectConfig(this.options.home, root, {
              trusted: !root || (await this.ctx.trust.isTrusted(root)),
            });
            if (
              (await decidePermission(
                {
                  id: "memory-ui",
                  name: "ProposeProjectMemory",
                  input: command.request,
                },
                {
                  ...config.permissions,
                  mode: session.permissionMode ?? config.permissions.mode,
                },
                session.cwd,
                { readOnly: session.readOnly },
              )) === "deny"
            )
              return {
                ok: false,
                error: "現在の権限ではメモリを変更できません。",
              };
            // Each explicit UI action authorizes this bounded edit, never a lasting tool grant.
            if (this.stopped || !this.sessions.get(session.id))
              return { ok: false, error: "Session unavailable" };
            return { ok: true, memory: await memory.action(command.request) };
          } finally {
            this.ctx.sessionBusy.delete(session.id);
          }
        }
        case "quota_resume": {
          if (this.stopped || !this.sessions.get(command.sessionId))
            return { ok: false, error: "Session unavailable" };
          const error = await this.quotaPauses.action(
            command.sessionId,
            command.action,
          );
          return error ? { ok: false, error } : { ok: true };
        }
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
            await this.quotaPauses.cancel(
              command.sessionId,
              "会話を削除したため取消しました。",
            );
            await this.sessions.delete(command.sessionId);
            await this.localBrowser.stop(command.sessionId);
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
        case "authenticate":
          return {
            ok: false,
            error:
              "この認証操作は廃止されました。公式CLI（claude / codex）で認証・更新してから再試行してください。現行ワークフローは資格情報の読取や自動更新を行いません。",
          };
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
          if (
            this.handoffBusy.has(command.sessionId) ||
            this.browserJobs.has(command.sessionId)
          )
            return {
              ok: false,
              error: "受け渡し・ローカル操作の終了後に権限を変更してください。",
            };
          return await setMode(this.ctx, command);
        case "ready": {
          this.connectionCheck?.abort.abort();
          for (const abort of this.browserJobs.values()) abort.abort();
          await this.localBrowser.stopAll();
          await Promise.all(
            [...this.browserJobs.keys()].map(
              (id) => this.runtimes.get(id)?.done,
            ),
          );
          this.handoffs.clear();
          // A reloaded renderer no longer owns local read promises. Cancel those
          // reads, without cancelling a paused task or granting its permissions.
          const reads = [...this.skillReads.entries()];
          for (const [, read] of reads) read.abort.abort();
          await Promise.all(reads.map(([id]) => this.runtimes.get(id)?.done));
          await this.refreshCommands();
          await this.emitState();
          for (const [id, rt] of this.runtimes) {
            if (rt.status === "idle") continue;
            this.options.emit({
              type: "transcript",
              sessionId: id,
              items: itemsFromMessages(rt.messages),
            });
            this.options.emit({
              type: "receipt_history",
              sessionId: id,
              receipts: rt.receipts ?? [],
            });
            this.options.emit({
              type: "turn",
              sessionId: id,
              status: "running",
            });
            if (rt.pending?.event) this.options.emit(rt.pending.event);
            if (rt.rewindPrompt?.event)
              this.options.emit(rt.rewindPrompt.event);
          }
          if (this.current) {
            await this.emitTranscript(this.current);
            if ((this.runtimes.get(this.current)?.status ?? "idle") === "idle")
              this.options.emit({
                type: "turn",
                sessionId: this.current,
                status: "idle",
              });
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
          if (
            [...this.browserJobs.keys()].some(
              (id) =>
                this.sessions.get(id)?.workspaceId === command.workspaceId,
            )
          )
            return {
              ok: false,
              error: "ローカル操作の終了後にprojectを変更してください。",
            };
          if (
            [...this.handoffBusy].some(
              (id) =>
                this.sessions.get(id)?.workspaceId === command.workspaceId,
            )
          )
            return {
              ok: false,
              error: "受け渡し終了後にprojectを変更してください。",
            };
          await this.workspaces.forget(command.workspaceId);
          await this.emitState();
          return { ok: true };
        case "siwc_account":
        case "check_connection": {
          if (command.type === "check_connection" && command.cancel) {
            if (
              this.connectionCheck &&
              this.connectionCheck.sessionId !== command.sessionId
            )
              return { ok: false, error: "別のセッションの接続確認です。" };
            this.connectionCheck?.abort.abort();
            return { ok: true };
          }
          if (!this.options.connections)
            return { ok: false, error: "開発版でのみ接続確認できます。" };
          if (
            this.connectionCheck ||
            this.sessions
              .list()
              .some(
                (s) =>
                  this.ctx.sessionBusy.has(s.id) ||
                  this.runtime(s.id).status !== "idle",
              )
          )
            return {
              ok: false,
              error: "実行・接続確認の完了後に確認してください。",
            };
          if (!this.sessions.get(command.sessionId))
            return { ok: false, error: "Unknown session" };
          const check = {
            sessionId: command.sessionId,
            abort: new AbortController(),
          };
          this.connectionCheck = check;
          try {
            if (command.type === "siwc_account") {
              if (!this.options.connections.account)
                return { ok: false, error: "SIWC接続は未設定です。" };
              await this.options.connections.account(
                command.action,
                command.account,
                check.abort.signal,
              );
            } else await this.options.connections.check(check.abort.signal);
            return {
              ok: !check.abort.signal.aborted,
              ...(check.abort.signal.aborted
                ? { error: "接続確認をキャンセルしました。" }
                : {}),
            } as CommandResult;
          } finally {
            if (this.connectionCheck === check)
              this.connectionCheck = undefined;
            await this.emitState();
          }
        }
        case "set_connection": {
          const session = this.sessions.get(command.sessionId);
          if (
            !this.options.connections ||
            !session ||
            !isConnectionChoice(command.connection)
          )
            return { ok: false, error: "開発版の接続選択を確認してください。" };
          if (
            this.ctx.sessionBusy.has(session.id) ||
            this.runtime(session.id).status !== "idle" ||
            this.connectionCheck
          )
            return {
              ok: false,
              error: "実行・接続確認の完了後に選択してください。",
            };
          this.ctx.sessionBusy.add(session.id);
          try {
            const rt = await this.load(session.id);
            const connectionAccount =
              command.connection === "openai-siwc"
                ? this.options.connections
                    .views()
                    .find((v) => v.mode === "openai-siwc")?.siwc?.selected
                : undefined;
            if (
              ((session.connection ?? "legacy") !== command.connection ||
                session.connectionAccount !== connectionAccount) &&
              rt.messages.length
            )
              return {
                ok: false,
                error:
                  "接続方式は空の新規セッションで選択してください。既存履歴を異なる認証経路へ転送しません。",
              };
            await this.sessions.save({
              ...(this.sessions.get(session.id) ?? session),
              connection: command.connection,
              connectionAccount,
            });
            await this.emitState();
            return { ok: true };
          } finally {
            this.ctx.sessionBusy.delete(session.id);
          }
        }
        case "set_siwc_model": {
          const session = this.sessions.get(command.sessionId);
          const view = this.options.connections
            ?.views()
            .find((v) => v.mode === "openai-siwc");
          if (
            !session ||
            this.connectionCheck ||
            this.ctx.sessionBusy.has(session.id) ||
            this.runtime(session.id).status !== "idle" ||
            view?.status !== "available" ||
            !view.siwc?.models.some((m) => m.slug === command.model)
          )
            return {
              ok: false,
              error: "選択したアカウントのモデル一覧を確認してください。",
            };
          this.ctx.sessionBusy.add(session.id);
          try {
            const rt = await this.load(session.id);
            if (
              rt.messages.length &&
              (session.connection !== "openai-siwc" ||
                session.connectionAccount !== view.siwc.selected)
            )
              return {
                ok: false,
                error: "空の新規セッションで接続とモデルを選択してください。",
              };
            await this.sessions.save({
              ...session,
              model: command.model,
              siwcServerDefault: true,
            });
            await this.emitState();
            return { ok: true };
          } finally {
            this.ctx.sessionBusy.delete(session.id);
          }
        }
        case "set_model":
          return await this.setModel(
            command.sessionId,
            command.model,
            command.effort,
          );
        case "close_session":
          if (this.connectionCheck?.sessionId === command.sessionId)
            this.connectionCheck.abort.abort();
          this.browserJobs.get(command.sessionId)?.abort();
          await this.localBrowser.stop(command.sessionId);
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
          return this.send(
            command.sessionId,
            command.text,
            command.images,
            command.officialTask,
          );
        case "abort": {
          if (this.connectionCheck?.sessionId === command.sessionId)
            this.connectionCheck.abort.abort();
          this.browserJobs.get(command.sessionId)?.abort();
          await this.localBrowser.stop(command.sessionId);
          this.preparations.get(command.sessionId)?.abort.abort();

          const rt = this.runtimes.get(command.sessionId);
          if (rt) this.release(rt);
          await this.quotaPauses.cancel(
            command.sessionId,
            "明示停止により自動再開を取り消しました。",
          );
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
          if (!this.options.cliModel) this.model = saved.model;
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
    const policyConfig = this.options.officialSession
      ? (projectMain ?? (await loadMainConfig(this.options.home)))
      : projectMain;
    const selectedModel = this.options.cliModel
      ? this.model
      : (projectMain?.choice.model ?? this.model);
    const selectedEffort =
      this.options.cliEffort ?? projectMain?.choice.effort ?? this.effort;
    let selection = selectedModel;
    if (this.options.officialSession) {
      try {
        const policy = resolveModelPolicy(
          selectedModel,
          selectedEffort,
          undefined,
          policyConfig?.aliases ?? this.options.aliases,
        );
        selection = `${policy.provider}:${policy.model}`;
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "モデル選択を確認できません。",
        };
      }
    }
    const session: StoredSession = {
      id,
      title: "New session",
      workspaceId,
      cwd,
      worktree,
      readOnly,
      model: selection,
      effort: selectedEffort,
      createdAt: now,
      updatedAt: now,
      fileLinkGuidanceVersion: 1,
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
    officialTask?: import("../../shared/official-session.js").OfficialTaskScope,
  ): Promise<CommandResult> {
    // Stop must remain usable while preparation/compact is awaiting I/O.
    if (
      /^(?:\/stop|(?:一旦)?(?:停止|中断)(?:して)?|止めて)[。！!]?$/u.test(
        text.trim(),
      )
    ) {
      if (images?.length && text.trim().startsWith("/"))
        return {
          ok: false,
          error: "画像は通常のメッセージと一緒に送信してください。",
        };
      if (!this.sessions.get(sessionId))
        return { ok: false, error: "Unknown session" };
      await this.handle({ type: "abort", sessionId });
      this.options.emit({
        type: "notice",
        sessionId,
        tone: "dim",
        message: "停止しました。再開するときは新しい指示を入力してください。",
      });
      return { ok: true };
    }
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Unknown session" };
    const root = this.ctx.workspaceRoot(session);
    if (root && this.ctx.worktreeBusy.has(root))
      return { ok: false, error: "Workspace writer busy" };
    if (this.ctx.sessionBusy.has(sessionId))
      return { ok: false, error: "Turn already running" };
    this.ctx.sessionBusy.add(sessionId);
    const abort = new AbortController();
    let finish!: () => void;
    const preparation = {
      abort,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
    };
    this.preparations.set(sessionId, preparation);
    try {
      await this.localBrowser.stop(sessionId);
      return await this.sendPrepared(
        sessionId,
        text,
        images,
        abort,
        officialTask,
      );
    } catch (error) {
      if (abort.signal.aborted)
        return { ok: false, error: "送信を中断しました。" };
      throw error;
    } finally {
      this.preparations.delete(sessionId);
      this.ctx.sessionBusy.delete(sessionId);
      finish();
    }
  }

  private async sendPrepared(
    sessionId: string,
    text: string,
    images: ImageAttachment[] | undefined,
    abort: AbortController,
    officialTask?: import("../../shared/official-session.js").OfficialTaskScope,
  ): Promise<CommandResult> {
    if (this.options.officialSession) {
      const session = this.sessions.get(sessionId)!;
      if (this.stopped) return { ok: false, error: "Shutting down" };
      const previous = await this.sessions.evaluationTask(sessionId);
      if (previous?.recoveryRequired)
        return { ok: false, error: RECOVERY_NOTICE };
      if (previous?.active)
        return {
          ok: false,
          error:
            "旧経路の未完了タスクを公式経路へ引き継ぐことはできません。記録と作業を保全し、新しいセッションを使用してください。",
        };
      if (images?.length || text.trim().startsWith("/"))
        return {
          ok: false,
          error:
            "公式経路はテキストの質問・作業依頼のみ対応しています。画像・旧slashコマンドには送信しません。モデルはモデル切替で選択してください。",
        };
      if (
        officialTask &&
        (session.readOnly ||
          session.permissionMode === "plan" ||
          !session.workspaceId)
      )
        return {
          ok: false,
          error:
            "作業依頼は書込み可能なプロジェクトを選択し、対象ファイルと独立テストを指定してください。",
        };
      if (!text.trim() || text.length > 4000)
        return { ok: false, error: "公式経路の入力は1〜4000文字です。" };
      const rt = await this.load(sessionId);
      // History I/O may overlap a worktree operation in another session.
      const root = this.ctx.workspaceRoot(session);
      if (
        (root && this.ctx.worktreeBusy.has(root)) ||
        this.otherWriterRunning(session)
      )
        return { ok: false, error: "Workspace writer busy" };
      if (rt.status !== "idle")
        return { ok: false, error: "Turn already running" };
      if (await this.reportMissingCwd(session))
        return { ok: false, error: "Working directory not found" };
      abort.signal.throwIfAborted();
      rt.abort = abort;
      rt.status = "running";
      rt.done = runOfficialSessionTurn(
        this.ctx,
        session,
        rt,
        text,
        abort,
        officialTask,
      ).catch(() => undefined);
      return { ok: true, sessionId };
    }
    if (this.connectionCheck)
      return { ok: false, error: "接続確認の完了後に送信してください。" };
    const selected = this.sessions.get(sessionId)?.connection ?? "legacy";
    if (this.options.connectionTest && selected === "legacy")
      return {
        ok: false,
        error: "Fixture profile requires an explicit new connection",
      };
    if (selected !== "legacy") {
      const view = (
        this.options.connections?.views() ?? unavailableConnections()
      ).find((v) => v.mode === selected);
      if (
        !isConnectionChoice(selected) ||
        view?.status !== "available" ||
        (selected === "openai-siwc" &&
          this.sessions.get(sessionId)?.connectionAccount !==
            view?.siwc?.selected) ||
        !this.options.connections?.selection(
          selected,
          this.sessions.get(sessionId)!.cwd,
        )
      )
        return { ok: false, error: view?.reason ?? "接続設定が不正です。" };
      if (images?.length || text.trim().startsWith("/"))
        return {
          ok: false,
          error:
            "新接続では通常のテキスト入力のみ対応しています。画像・段階指示・圧縮コマンドは未対応です。",
        };
      const route = resolveModel(
        this.sessions.get(sessionId)!.model,
        this.options.aliases,
      );
      if (
        !this.options.fake &&
        selected !== "openai-siwc" &&
        route?.provider !== "claude"
      )
        return {
          ok: false,
          error: "接続方式に対応するモデルを明示選択してください。",
        };
      if (
        selected === "openai-siwc" &&
        view?.siwc &&
        !view.siwc.models.some(
          (m) => m.slug === this.sessions.get(sessionId)!.model,
        )
      )
        return {
          ok: false,
          error: "選択したアカウントのモデル一覧からモデルを選択してください。",
        };
    }
    if (selected === "legacy")
      return {
        ok: false,
        error:
          "旧HTTP・旧workflow実行は廃止されました。公式ワークフローを使用してください。",
      };
    const session = this.sessions.get(sessionId)!;
    const root = this.ctx.workspaceRoot(session);
    const rt = await this.load(sessionId);
    abort.signal.throwIfAborted();
    if (root && this.ctx.worktreeBusy.has(root))
      return { ok: false, error: "Workspace writer busy" };
    if (rt.status !== "idle")
      return { ok: false, error: "Turn already running" };
    if (this.otherWriterRunning(session))
      return { ok: false, error: "Workspace writer busy" };
    if (await this.reportMissingCwd(session))
      return { ok: false, error: "Working directory not found" };
    abort.signal.throwIfAborted();
    rt.abort = abort;
    rt.status = "running";
    rt.closing = false;
    rt.done = runSessionTurn(
      this.ctx,
      this.gate,
      session,
      rt,
      text,
      undefined,
      abort,
    );
    return { ok: true, sessionId };
  }

  /** Testable clock tick; the desktop timer uses the same durable lease path. */
  async tickQuotaResume() {
    await this.quotaPauses.tick();
  }

  private async resumeQuota(
    pause: QuotaPause,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const id = pause.sessionId;
    const session = this.sessions.get(id);
    if (
      this.stopped ||
      signal.aborted ||
      !session ||
      this.ctx.sessionBusy.has(id) ||
      (this.runtimes.get(id)?.status ?? "idle") !== "idle"
    )
      return "会話が利用できないため自動再開しません。";
    if (
      this.otherWriterRunning(session) ||
      (this.ctx.workspaceRoot(session) &&
        this.ctx.worktreeBusy.has(this.ctx.workspaceRoot(session)!))
    )
      return "作業場所が使用中です。手動で確認してください。";
    this.ctx.sessionBusy.add(id);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal.addEventListener("abort", cancel, { once: true });
    let rt: Runtime | undefined;
    try {
      const task = await this.sessions.evaluationTask(id);
      if (
        !task?.active ||
        task.recoveryRequired ||
        task.id !== pause.snapshot.taskId
      )
        return "保存・タスク境界が一致しません。レポートを確認してください。";
      if (
        session.model !== pause.model ||
        session.effort !== pause.snapshot.effort ||
        session.premiseHash !== pause.snapshot.premiseHash ||
        session.readOnly !== pause.snapshot.readOnly ||
        session.permissionMode !== pause.snapshot.permissionMode
      )
        return "モデル・effort・権限・前提が変わったため停止しました。";
      if (
        (await resumeConditions(this.ctx, session)) !==
        pause.snapshot.conditionsHash
      )
        return "設定・作業場所・HEAD・前提が変わったため停止しました。";
      this.ctx.dropRuntime(id); // Rebuild fresh tools/system; never restore temporary grants.
      rt = await this.load(id);
      rt.checkpoint = await checkpointFile(this.options.home, id).read(
        undefined,
      );
      if (
        rt.messages.length !== pause.snapshot.messageCount ||
        resumeHash(rt.messages) !== pause.snapshot.messagesHash ||
        resumeHash(rt.checkpoint ?? null) !== pause.snapshot.checkpointHash ||
        rt.messages.at(-1)?.role !== "user"
      )
        return "会話または圧縮チェックポイントが変わったため停止しました。";
      abort.signal.throwIfAborted();
      rt.status = "running";
      rt.quotaContinuation = true;
      rt.abort = abort;
      rt.quotaGuard = async () =>
        (await resumeConditions(this.ctx, session)) ===
        pause.snapshot.conditionsHash;
      rt.done = runSessionTurn(
        this.ctx,
        this.gate,
        session,
        rt,
        "",
        undefined,
        abort,
        true,
      );
      await rt.done;
      const settled = await this.sessions.evaluationTask(id);
      if (settled?.id !== pause.snapshot.taskId || settled.settled !== true)
        return "再開結果の保存が未確定です。レポートを確認してください。";
      if (rt.lastStopCause === "rate_limited")
        return "枠がまだ利用できません。新しい枠待ち情報を確認してください。";
      return ["end_turn", "reported_done", "workflow_complete"].includes(
        rt.lastStopCause ?? "",
      )
        ? undefined
        : "再開が正常完了していません。権限・認証・前提・レポートを手動で確認してください。";
    } catch {
      return "再開の前提・保存・実行を確認できないため停止しました。";
    } finally {
      if (rt) rt.quotaContinuation = false;
      signal.removeEventListener("abort", cancel);
      this.ctx.sessionBusy.delete(id);
      await this.emitState();
    }
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
    signal?: AbortSignal,
    expected?: { provider: string; model: string },
  ): Promise<CommandResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { ok: false, error: "Unknown session" };
    const cfg =
      this.options.phase4 || this.options.officialSession
        ? await loadMainConfig(
            this.options.home,
            undefined,
            this.ctx.workspaceRoot(session),
          )
        : undefined;
    let policyModel: string | undefined;
    let resolved: ReturnType<typeof resolveModel>;
    if (this.options.officialSession) {
      try {
        const policy = resolveModelPolicy(
          spec,
          effort ?? session.effort,
          undefined,
          cfg?.aliases ?? this.options.aliases,
        );
        policyModel = `${policy.provider}:${policy.model}`;
        resolved = { provider: policy.provider, model: policy.id };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error
              ? error.message
              : "モデル選択を確認できません。",
        };
      }
    } else resolved = resolveModel(spec, cfg?.aliases ?? this.options.aliases);
    if (
      expected &&
      (resolved?.model !== expected.model ||
        resolved?.provider !== expected.provider)
    )
      return {
        ok: false,
        error:
          "aliasが候補のモデルを変更します。設定と候補を再確認してください。",
      };
    const known =
      resolved &&
      (this.options.officialSession
        ? loadModelCatalog().some(
            (m) =>
              m.enabled &&
              m.provider === resolved.provider &&
              m.id === resolved.model,
          )
        : (this.options.providers ?? [this.options.provider]).some((p) =>
            p.models().some((m) => m.id === resolved.model),
          ));
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
    signal?.throwIfAborted();
    await this.sessions.save({
      ...session,
      model: policyModel ?? resolved.model,
      siwcServerDefault: false,
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
    this.preparations.get(sessionId)?.abort.abort();

    await this.quotaPauses.cancel(
      sessionId,
      "会話を閉じたため、自動再開を取り消しました。",
    );
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
    // Fence new commands and automatic work before the first asynchronous close.
    this.stopped = true;
    this.connectionCheck?.abort.abort();
    for (const abort of this.browserJobs.values()) abort.abort();
    this.handoffs.clear();
    const quotaClosed = this.quotaPauses.close();

    this.repositories.abort();
    const running: Promise<void>[] = [];
    for (const preparation of this.preparations.values()) {
      preparation.abort.abort();
      running.push(preparation.done);
    }
    for (const rt of this.runtimes.values()) {
      this.release(rt);
      if (rt.done) running.push(rt.done);
    }
    await this.localBrowser.stopAll();
    await this.handoffs.drain();
    await quotaClosed;
    await Promise.race([
      Promise.all(running),
      new Promise<void>((r) => setTimeout(r, timeoutMs).unref?.()),
    ]);
    await this.options.connections?.close?.();
  }
}
