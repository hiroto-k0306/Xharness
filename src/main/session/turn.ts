// 1ターン(ユーザーの1発言 → 応答の完了)を実行し、履歴とレシートを保存する。
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runConnectedTurnOwned } from "../connections/integration.js";
import { withSessionTrace, withTaskTrace } from "../core/trace.js";
import { FILE_LINK_GUIDANCE } from "../core/output-guidance.js";
import { withSessionCalls } from "./llm-calls.js";
import {
  LlmBudgetError,
  llmStopCause,
  flushLlmCalls,
} from "../core/llm-budget.js";
import { resolve } from "node:path";
import { loadAgentConfig } from "../agents/definitions.js";
import { resolveModel } from "../config/config.js";
import {
  loadProjectConfig,
  projectMemory,
  type ProjectConfig,
} from "../config/project.js";
import { hasProjectCommands } from "./slash-commands.js";
import { FileCheckpointStore } from "../checkpoints/store.js";
import { usedProviders, type StoredSession } from "./store.js";
import { type PermissionGate } from "./permission-gate.js";
import { TurnEvents } from "./turn-events.js";
import { itemsFromMessages } from "./transcript.js";
import {
  sessionTools,
  STOP_NOTICE,
  type ControllerContext,
  type Runtime,
} from "./context.js";

/** システムプロンプト。プロジェクト設定があればメモリファイル(§12)を、無ければ AGENTS.md / CLAUDE.md を足す */
export async function systemPrompt(
  ctx: ControllerContext,
  cwd: string,
  scratch = false,
  config?: ProjectConfig,
  includeFileLinkGuidance = true,
): Promise<string> {
  let system = `You are a coding agent working in ${cwd}. Use Read before modifying existing files. Bash executes PowerShell 7 and already runs in this working directory, so do not prefix commands with cd or Set-Location. Tool dates use ISO 8601. Respect project instructions. Reply in Japanese unless asked otherwise.`;
  if (includeFileLinkGuidance) system += `\n\n${FILE_LINK_GUIDANCE}`;
  if (config)
    return (
      system +
      "\n\n" +
      ctx.clean(
        await projectMemory(
          ctx.options.home,
          scratch ? undefined : cwd,
          config.context.memoryFiles,
        ),
      )
    );
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      system +=
        `\n\n${name}:\n` +
        ctx.clean(await readFile(resolve(cwd, name), "utf8"));
    } catch {
      /* 任意のファイル */
    }
  }
  return system;
}

/** 発言を履歴に足し、初回ならタイトルを付けて、画面に「実行中」を知らせる */
async function beginTurn(
  ctx: ControllerContext,
  session: StoredSession,
  rt: Runtime,
  text: string,
  note?: string,
  images?: import("../../shared/images.js").ImageAttachment[],
): Promise<StoredSession> {
  const { emit } = ctx.options;
  const sessionId = session.id;
  const first = rt.messages.length === 0;
  // note(MCP の一覧の変化など)はモデルにだけ伝え、画面の発言には出さない
  rt.messages.push({
    role: "user",
    content: [
      ...(text.trim()
        ? [{ type: "text" as const, text: ctx.clean(text) }]
        : []),
      ...(images ?? []).map((image) => ({ type: "image" as const, ...image })),
      ...(note ? [{ type: "text" as const, text: ctx.clean(note) }] : []),
    ],
  });
  if (first) {
    session = {
      ...(ctx.sessions.get(sessionId) ?? session),
      title:
        ctx.clean(text).replace(/\s+/g, " ").trim().slice(0, 40) ||
        session.title,
    };
    await ctx.sessions.save(session);
  }
  // new_session の transcript と invoke の返答は別チャネル。発言も main の
  // イベント順に流し、遅れて届いた空の transcript が発言を消す競合を防ぐ。
  emit({
    type: "user_message",
    sessionId,
    messageId: `${sessionId}-u${rt.messages.length}`,
    text: ctx.clean(text),
    ...(images?.length ? { images } : {}),
  });
  emit({ type: "turn", sessionId, status: "running" });
  await ctx.refreshCommands?.();
  await ctx.emitState();
  return session;
}

/**
 * プロジェクト設定を読む。権限を広げる項目(allow ルール・acceptEdits)があり、
 * まだ信頼していないワークスペースなら、内容を見せて信頼するか尋ねる(Claude Code の workspace trust)。
 * 「常に」は記録し、「許可」はこのセッションだけ、「拒否」は広げる項目を適用せずに続ける。
 */
async function loadTrustedConfig(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  root: string | undefined,
  signal: AbortSignal,
): Promise<ProjectConfig> {
  const home = ctx.options.home;
  const trusted = async () =>
    !root || !!rt.trustedSession || (await ctx.trust.isTrusted(root));
  let config = await loadProjectConfig(home, root, {
    trusted: await trusted(),
  });
  if (
    !root ||
    rt.trustDeclined ||
    (await trusted()) ||
    (!config.untrusted && !(await hasProjectCommands(session.cwd)))
  )
    return config;
  const decision = await gate.request({
    session,
    rt,
    call: {
      name: "ProjectSettings",
      input: {
        workspace: root,
        ...config.untrusted,
        commands: "プロジェクトのユーザー定義コマンドも有効にします",
      },
    },
    signal,
    forceAsk: true,
  });
  if (decision === "always") await ctx.trust.trust(root);
  else if (decision === "allow" || decision === "session")
    rt.trustedSession = true;
  else {
    rt.trustDeclined = true;
    ctx.options.emit({
      type: "notice",
      sessionId: session.id,
      tone: "warn",
      message:
        "このワークスペースの設定にある許可ルール・自動モードは適用せずに続けます(deny / ask は適用します)",
    });
    return config;
  }
  await ctx.refreshCommands?.();
  await ctx.emitState();
  const heldMode = config.untrusted?.mode;
  config = await loadProjectConfig(home, root, { trusted: true });
  // 信頼前に作ったセッションは既定モードのまま保存されている。保留していたモードを反映する
  const latest = ctx.sessions.get(session.id);
  if (
    heldMode &&
    latest &&
    !latest.readOnly &&
    (latest.permissionMode ?? "default") === "default"
  )
    await ctx.sessions.save({ ...latest, permissionMode: heldMode });
  return config;
}

/** One native submission; inferred work waits for scope and plan approval. */
export async function runOfficialSessionTurn(
  ctx: ControllerContext,
  session: StoredSession,
  rt: Runtime,
  text: string,
  abort: AbortController,
  task?: import("../../shared/official-session.js").OfficialTaskScope,
) {
  const events = new TurnEvents(ctx, session, rt);
  const startedAt = performance.now();
  let stopCause = "step_failed";
  ctx.options.emit({ type: "official_scope_required", sessionId: session.id });
  try {
    const history = rt.messages.slice(-10).flatMap((m) => {
      const text = m.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      return text && (m.role === "user" || m.role === "assistant")
        ? [{ role: m.role, text }]
        : [];
    });
    session = await beginTurn(ctx, session, rt, text);
    // Persist the input even if configuration or native connection prevents dispatch.
    await ctx.sessions.append(
      session.id,
      rt.messages.slice(rt.persisted),
      ctx.clean,
    );
    rt.persisted = rt.messages.length;
    const projectRoot = ctx.workspaceRoot(session);
    const config = await loadProjectConfig(
      ctx.options.home,
      task || session.workspaceId ? projectRoot : undefined,
    );
    const agents = await loadAgentConfig(
      ctx.options.home,
      task || session.workspaceId ? projectRoot : undefined,
    );
    if (
      config.limits.llmCallsPerTurn ||
      config.limits.llmCallsPerSession ||
      agents.hooks?.length ||
      agents.waveChecks.length ||
      (task &&
        (config.permissions.rules.length ||
          config.permissions.mode === "plan" ||
          config.untrusted))
    )
      throw new Error(
        "公式入力の初期対応では既存の通信回数上限・フック・プロジェクト権限設定を適用できません。設定を無視せず停止しました。保存設定は変更していません。",
      );
    const chosen = resolveModel(session.model, ctx.options.aliases);
    if (!chosen)
      throw new Error(
        "選択モデルを公式IDへ解決できません。旧HTTPへ切り替えません。",
      );
    abort.signal.throwIfAborted();
    const result = await ctx.options.officialSession!(
      {
        sessionId: session.id,
        cwd: session.cwd,
        model: `${chosen.provider}:${chosen.model}`,
        effort: session.effort,
        text: ctx.clean(text),
        history,
        automaticWork:
          !!session.workspaceId &&
          !session.readOnly &&
          (session.permissionMode ?? config.permissions.mode) !== "plan" &&
          !config.permissions.rules.length &&
          !config.untrusted,
        autoOperations:
          (session.permissionMode ?? config.permissions.mode) === "acceptEdits",
        ...(task ? { task } : {}),
        ...(session.worktree && projectRoot
          ? { worktreeSource: projectRoot }
          : {}),
      },
      abort.signal,
    );
    const summary = ctx.clean(result.summary);
    events.record({
      id: events.nextReceiptId(),
      sessionId: session.id,
      ts: Date.now(),
      provider: "harness",
      kind: "tool",
      tool: "OfficialWorkflow",
      durationMs: Math.round(performance.now() - startedAt),
      input: {
        workflowId: result.workflowId,
        intent:
          result.intent ?? (task || result.taskRequired ? "work" : "question"),
      },
      summary: `公式workflow ${result.workflowId} / ${result.status}。詳細のusage・テスト・レビューは公式workflowの保存記録を参照。`,
    });
    rt.messages.push({
      role: "assistant",
      content: [{ type: "text", text: summary }],
      meta: {
        officialWorkflow: {
          id: result.workflowId,
          status: result.status,
          taskRequired: result.taskRequired,
        },
      },
    });
    ctx.options.emit({
      type: "transcript",
      sessionId: session.id,
      items: itemsFromMessages(rt.messages),
    });
    ctx.options.emit({
      type: "notice",
      sessionId: session.id,
      tone: "dim",
      message: `公式workflow ${result.workflowId} / ${result.status}。計画承認・テスト・レビュー・使用量は公式workflowで確認できます。`,
    });
    stopCause = abort.signal.aborted
      ? "aborted"
      : result.status === "completed"
        ? result.taskRequired
          ? "awaiting_user"
          : task || result.intent === "work"
            ? "workflow_complete"
            : "end_turn"
        : result.status === "cancelled" || abort.signal.aborted
          ? "aborted"
          : "review_attention";
    ctx.options.emit({
      type: "official_scope_required",
      sessionId: session.id,
      text:
        result.taskRequired &&
        result.status === "completed" &&
        !abort.signal.aborted
          ? ctx.clean(text)
          : undefined,
    });
  } catch (error) {
    stopCause = abort.signal.aborted ? "aborted" : "step_failed";
    if (!abort.signal.aborted)
      ctx.options.emit({
        type: "error",
        sessionId: session.id,
        message: ctx.clean(
          error instanceof Error
            ? error.message
            : "公式接続を実行できません。旧HTTPへ切り替えません。",
        ),
      });
  } finally {
    events.flush();
    await finishTurn(ctx, session, rt, events, stopCause);
  }
}

export async function runSessionTurn(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  text: string,
  images?: import("../../shared/images.js").ImageAttachment[],
  abort = new AbortController(),
  continuation = false,
): Promise<void> {
  rt.abort = abort;
  try {
    const config = await loadProjectConfig(ctx.options.home);
    await withSessionCalls(
      {
        home: ctx.options.home,
        id: session.id,
        limits: config.limits,
        abort,
        changed: (calls) => {
          rt.llmCalls = calls;
          void ctx.emitState();
        },
      },
      () =>
        runSessionBody(
          ctx,
          gate,
          session,
          rt,
          text,
          abort,
          images,
          continuation,
        ),
    );
  } catch (error) {
    const stopCause =
      error instanceof LlmBudgetError
        ? error.reason
        : abort.signal.aborted
          ? "aborted"
          : "step_failed";
    rt.status = "idle";
    rt.lastStopCause = stopCause;
    rt.abort = undefined;
    ctx.options.emit({
      type: "notice",
      sessionId: session.id,
      tone: "warn",
      message:
        STOP_NOTICE[stopCause] ?? "通信回数の設定・保存先を確認してください。",
    });
    ctx.options.emit({
      type: "turn",
      sessionId: session.id,
      status: "idle",
      stopCause,
    });
  } finally {
    if (rt.closing && rt.status === "idle") ctx.dropRuntime(session.id);
    await ctx.emitState();
  }
}
async function runSessionBody(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  text: string,
  abort: AbortController,
  images?: import("../../shared/images.js").ImageAttachment[],
  continuation = false,
): Promise<void> {
  const { options } = ctx;
  const { emit } = options;
  const sessionId = session.id;
  const clean = ctx.clean;
  const events = new TurnEvents(ctx, session, rt);
  if (!continuation)
    session = await beginTurn(ctx, session, rt, text, undefined, images);
  else {
    emit({ type: "turn", sessionId, status: "running" });
    await ctx.emitState();
  }
  let stopCause = "step_failed";
  if (session.connection && session.connection !== "legacy") {
    let featureReason: string | undefined;
    try {
      const selection = options.connections?.selection(
        session.connection,
        session.cwd,
      );
      if (!selection) throw new Error("Connection unavailable");
      rt.tools ??= sessionTools(ctx, session);
      rt.config = await loadTrustedConfig(
        ctx,
        gate,
        session,
        rt,
        ctx.workspaceRoot(session),
        abort.signal,
      );
      const trustRoot = ctx.workspaceRoot(session);
      const agentConfig = await loadAgentConfig(
        options.home,
        session.workspaceId ? session.cwd : undefined,
        !trustRoot ||
          !!rt.trustedSession ||
          (await ctx.trust.isTrusted(trustRoot)),
      );
      if (agentConfig.hooks?.length || agentConfig.waveChecks?.length) {
        featureReason =
          "新接続は設定済みのXフック・wave checkに未対応です。保護設定を無視せず停止します。既存方式の新規セッションを使用してください。";
        throw new Error("Unsupported hooks");
      }
      const checkpoint = await new FileCheckpointStore(options.home).begin(
        sessionId,
        session.cwd,
        rt.messages.length - 1,
        clean,
        (message) => emit({ type: "notice", sessionId, tone: "warn", message }),
      );
      const previous = await ctx.sessions.evaluationTask(sessionId);
      rt.evaluationTaskId = previous?.active ? previous.id : randomUUID();
      await ctx.sessions.recordEvaluationTask(
        sessionId,
        rt.evaluationTaskId,
        true,
        false,
      );
      await ctx.sessions.append(
        sessionId,
        rt.messages.slice(rt.persisted),
        clean,
      );
      rt.persisted = rt.messages.length;
      const model =
        session.connection === "openai-siwc"
          ? session.model
          : (resolveModel(session.model, options.aliases)?.model ??
            session.model);
      rt.system ??= await systemPrompt(
        ctx,
        session.cwd,
        !session.workspaceId,
        rt.config,
        session.fileLinkGuidanceVersion === 1,
      );
      const result = await withSessionTrace(
        options.home,
        sessionId,
        clean,
        () =>
          withTaskTrace(
            {
              taskId: rt.evaluationTaskId!,
              model,
              effort: session.siwcServerDefault ? undefined : session.effort,
            },
            () =>
              runConnectedTurnOwned(
                options.home,
                {
                  provider: options.provider,
                  sessionId,
                  model,
                  ...(session.siwcServerDefault
                    ? {}
                    : { reasoning: { effort: session.effort } }),
                  system: rt.system!,
                  messages: rt.messages,
                  tools: rt.tools!,
                  checkpoint,
                  redact: clean,
                  maxRounds: options.connectionTest ? 2 : 4,
                  permission: (call, signal) =>
                    gate.ask({
                      session,
                      rt,
                      call,
                      receiptId: events.receiptByCall.get(call.id),
                      signal,
                      forceAsk: options.connectionTest,
                    }),
                  onEvent: events.onEvent,
                },
                { ...selection, taskId: rt.evaluationTaskId! },
                abort.signal,
              ),
          ),
      );
      rt.messages = result.messages;
      stopCause = result.stopCause;
    } catch {
      stopCause = abort.signal.aborted ? "aborted" : "step_failed";
      if (!abort.signal.aborted)
        emit({
          type: "error",
          sessionId,
          message:
            featureReason ??
            "新接続を開始できませんでした。公式認証・Usage設定と実行台帳を確認してください。自動切替は行いません。",
        });
    }
    events.flush();
    await finishTurn(ctx, session, rt, events, llmStopCause() ?? stopCause);
    return;
  }
  emit({
    type: "error",
    sessionId,
    message:
      "旧HTTP・旧workflow実行は廃止されました。公式ワークフローを使用してください。暗黙の切替は行いません。",
  });
  await finishTurn(ctx, session, rt, events, "legacy_unavailable");
}

/** 履歴・レシート・索引を保存し、idle に戻す */
async function finishTurn(
  ctx: ControllerContext,
  session: StoredSession,
  rt: Runtime,
  events: TurnEvents,
  stopCause: string,
) {
  const { emit } = ctx.options;
  const sessionId = session.id;
  let saved = false;
  try {
    await flushLlmCalls();
    stopCause = llmStopCause() ?? stopCause;
    await Promise.all(events.receiptWrites);
    await ctx.sessions.append(
      sessionId,
      rt.messages.slice(rt.persisted),
      ctx.clean,
    );
    rt.persisted = rt.messages.length;
    // 実行中に set_model された内容を上書きしないよう、最新の記録に重ねて保存する
    const latest = ctx.sessions.get(sessionId) ?? session;
    await ctx.sessions.save({
      ...latest,
      updatedAt: Date.now(),
      providers: usedProviders(rt.messages, latest.providers),
    });
    if (rt.evaluationTaskId)
      await ctx.sessions.recordEvaluationTask(
        sessionId,
        rt.evaluationTaskId,
        !(
          stopCause === "workflow_complete" ||
          stopCause === "reported_done" ||
          stopCause === "end_turn"
        ),
        true,
      );
    saved = true;
  } catch {
    emit({ type: "error", sessionId, message: "履歴の保存に失敗しました" });
  }
  if (stopCause === "rate_limited" && events.quotaRate && ctx.quotaPaused)
    await ctx
      .quotaPaused(ctx.sessions.get(sessionId) ?? session, rt, {
        rate: events.quotaRate,
        unsafe: events.resumeUnsafe || !!rt.abort?.signal.aborted,
        saved,
      })
      .catch(() =>
        emit({
          type: "error",
          sessionId,
          message: "枠待ちを安全に保存できません。自動再開しません。",
        }),
      );
  rt.abort = undefined;
  rt.pending = undefined;
  rt.status = "idle";
  const notice = STOP_NOTICE[stopCause];
  rt.lastStopCause = stopCause;
  if (notice && stopCause !== "aborted")
    if (["agent_stopped", "awaiting_user"].includes(stopCause))
      emit({ type: "notice", sessionId, tone: "dim", message: notice });
    else emit({ type: "error", sessionId, message: notice });
  emit({ type: "turn", sessionId, status: "idle", stopCause });
  if (rt.closing) ctx.dropRuntime(sessionId);
  await ctx.emitState();
}
