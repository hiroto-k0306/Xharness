import { randomUUID } from "node:crypto";
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
import {
  finishWorktree,
  RepositoryOpener,
  restoreWorktree,
} from "./worktree-commands.js";
import { emitMcpState, MCP_COMMAND } from "./mcp-session.js";
import { exportExecutionReport } from "./report.js";

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

  constructor(private readonly options: ControllerOptions) {
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
    if (!this.options.fake) await this.options.authentication?.refresh();
    await Promise.all([this.sessions.load(), this.workspaces.load()]);
    this.sessions.fillDefaults({ model: this.model, effort: this.effort });
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
      authentication: this.options.fake
        ? undefined
        : this.options.authentication?.snapshot(),
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
    if (
      /^(?:\/stop|(?:一旦)?(?:停止|中断)(?:して)?|止めて)[。！!]?$/u.test(
        text.trim(),
      )
    ) {
      if (!this.sessions.get(sessionId))
        return { ok: false, error: "Unknown session" };
      const rt = this.runtimes.get(sessionId);
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
      if (!model || extra || (effort !== undefined && !isEffort(effort)))
        return { ok: false, error: "Usage: /model provider:model [effort]" };
      return this.setModel(sessionId, model, effort as Effort | undefined);
    }
    const rt = await this.load(sessionId);
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
    rt.status = "running";
    // 作業フォルダが無いときは、モデルを呼ばずツールも動かさずに知らせる(§18.4)
    if (await this.reportMissingCwd(session)) {
      rt.status = "idle";
      return { ok: false, error: "Working directory not found" };
    }
    rt.closing = false;
    rt.done = runSessionTurn(this.ctx, this.gate, session, rt, text).catch(
      () => undefined,
    );
    return { ok: true, sessionId };
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
          this.runtimes.get(other.id)?.status !== undefined &&
          this.runtimes.get(other.id)?.status !== "idle",
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
    if (!this.sessions.get(sessionId))
      return { ok: false, error: "Unknown session" };
    const rt = this.runtimes.get(sessionId);
    if (rt) {
      rt.closing = true;
      this.release(rt);
      if (rt.status === "idle") this.ctx.dropRuntime(sessionId);
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
