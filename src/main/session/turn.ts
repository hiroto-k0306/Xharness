// 1ターン(ユーザーの1発言 → 応答の完了)を実行し、履歴とレシートを保存する。
import { readFile } from "node:fs/promises";
import { withSessionCalls } from "./llm-calls.js";
import {
  LlmBudgetError,
  llmStopCause,
  flushLlmCalls,
} from "../core/llm-budget.js";
import { resolve } from "node:path";
import { loadAgentConfig } from "../agents/definitions.js";
import { loadMainConfig, resolveModel } from "../config/config.js";
import {
  loadProjectConfig,
  projectMemory,
  type ProjectConfig,
} from "../config/project.js";
import { estimateTokens } from "../context/compactor.js";
import { hasProjectCommands } from "./slash-commands.js";
import { prepareProviderHistory } from "../context/provider-compactor.js";
import { Router } from "../core/router.js";
import { webTools } from "../tools/web.js";
import { diagnoseEnvironment } from "../tools/environment.js";
import { FileCheckpointStore } from "../checkpoints/store.js";
import { type Receipt } from "../../shared/ipc.js";
import { usedProviders, type StoredSession } from "./store.js";
import { type PermissionGate } from "./permission-gate.js";
import { TurnEvents, usageEvent } from "./turn-events.js";
import { createWorkflow, needsNewWorkflow } from "./workflow-factory.js";
import {
  checkpointFile,
  defaultTools,
  safeInput,
  STOP_NOTICE,
  type ControllerContext,
  type Runtime,
} from "./context.js";
import {
  expandMcpPrompt,
  handleMcpCommand,
  mcpCommandError,
  MCP_PROMPT_COMMAND,
  mcpChangeNote,
  prepareMcp,
} from "./mcp-session.js";

/** システムプロンプト。プロジェクト設定があればメモリファイル(§12)を、無ければ AGENTS.md / CLAUDE.md を足す */
export async function systemPrompt(
  ctx: ControllerContext,
  cwd: string,
  scratch = false,
  config?: ProjectConfig,
): Promise<string> {
  let system = `You are a coding agent working in ${cwd}. Use Read before modifying existing files. Bash executes PowerShell 7 and already runs in this working directory, so do not prefix commands with cd or Set-Location. Tool dates use ISO 8601. Respect project instructions. Reply in Japanese unless asked otherwise.`;
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
        "このワークスペースの設定にある許可ルール・acceptEdits は適用せずに続けます(deny / ask は適用します)",
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

/** ツール・設定・圧縮チェックポイントを、このターン用に読み直す */
async function prepareRuntime(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  signal: AbortSignal,
) {
  const { options } = ctx;
  const root = ctx.workspaceRoot(session);
  rt.tools ??= (options.createTools ?? defaultTools)(
    // Per-session policies are evaluated at the permission gate.
    session.cwd,
    session.readOnly,
  );
  if (options.phase4) {
    rt.config = await loadTrustedConfig(ctx, gate, session, rt, root, signal);
    rt.mainConfig = await loadMainConfig(options.home, undefined, root);
  }
  const web = rt.mainConfig?.web ?? options.web;
  const webSignature = JSON.stringify(web);
  if (rt.webSignature !== webSignature) {
    rt.webSignature = webSignature;
    rt.tools.delete("WebSearch");
    rt.tools.delete("WebFetch");
    if (web?.enabled)
      for (const [name, tool] of webTools(
        () =>
          new Router(options.providers ?? [options.provider]).provider(
            (ctx.sessions.get(session.id) ?? session).model,
          ),
        web.searchMode,
        options.fake,
        (event) => {
          // Web の要約・検索の通信でも枠を更新する(auto の選択が古い値を使わないように)
          if (event.type === "usage") options.emit(usageEvent(ctx, event));
        },
        {
          settings: web,
          providers: () => options.providers ?? [options.provider],
          usage: ctx.usage,
          budget: (rt.searchBudget ??= {
            used: 0,
            limit: web.maxSearchesPerSession ?? 100,
          }),
        },
      ))
        rt.tools.set(name, tool);
  }
  // MCP はセッションの最初のターンでだけ準備する(tools を途中で変えない。§24・§25)
  await prepareMcp(ctx, gate, session, rt, signal);
  if (options.phase4 && !rt.checkpoint)
    rt.checkpoint = await checkpointFile(options.home, session.id).read(
      undefined,
    );
  return { web };
}

export async function runSessionTurn(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  text: string,
  images?: import("../../shared/images.js").ImageAttachment[],
): Promise<void> {
  const abort = new AbortController();
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
      () => runSessionBody(ctx, gate, session, rt, text, abort, images),
    );
  } catch (error) {
    const stopCause =
      error instanceof LlmBudgetError ? error.reason : "step_failed";
    rt.status = "idle";
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
): Promise<void> {
  const { options } = ctx;
  const { emit } = options;
  const sessionId = session.id;
  const clean = ctx.clean;
  const events = new TurnEvents(ctx, session, rt);
  if (MCP_PROMPT_COMMAND.test(text.trim())) {
    // MCP のプロンプトは、接続を準備してから展開し、確認後に通常の発言として送る(§25.6)
    let expanded: Awaited<ReturnType<typeof expandMcpPrompt>>;
    try {
      await prepareRuntime(ctx, gate, session, rt, abort.signal);
      expanded = await expandMcpPrompt(
        ctx,
        gate,
        session,
        rt,
        text,
        abort.signal,
      );
    } catch {
      expanded = { error: "MCP のプロンプトを準備できませんでした" };
    }
    if ("error" in expanded) {
      emit({
        type: "notice",
        sessionId,
        tone: "warn",
        message: expanded.error,
      });
      rt.abort = undefined;
      rt.status = "idle";
      emit({ type: "turn", sessionId, status: "idle", stopCause: "aborted" });
      if (rt.closing) ctx.dropRuntime(sessionId);
      await ctx.emitState();
      return;
    }
    text = expanded.text;
  }
  session = await beginTurn(
    ctx,
    session,
    rt,
    text,
    mcpChangeNote(rt.mcp),
    images,
  );
  let stopCause = "step_failed";
  try {
    const { web } = await prepareRuntime(ctx, gate, session, rt, abort.signal);
    const files = new FileCheckpointStore(options.home);
    await files.purge(rt.config?.checkpoints?.retentionDays ?? 30);
    const fileCheckpoint = await files.begin(
      sessionId,
      session.cwd,
      rt.messages.length - 1,
      clean,
      (message) => emit({ type: "notice", sessionId, tone: "warn", message }),
    );
    if (!rt.environment) {
      rt.environment =
        session.environment ?? (await diagnoseEnvironment(session.cwd));
      if (!session.environment) {
        await ctx.sessions.save({
          ...(ctx.sessions.get(sessionId) ?? session),
          environment: rt.environment,
        });
        for (const message of rt.environment.warnings)
          emit({ type: "notice", sessionId, tone: "warn", message });
      }
    }
    // preserved thinking: system は過去の thinking の前提として検査されるため、
    // セッションの最初に決めたら変えない(途中で AGENTS.md が編集されても次のセッションから反映)
    rt.system ??=
      (await systemPrompt(ctx, session.cwd, !session.workspaceId, rt.config)) +
      "\n" +
      rt.environment.summary;
    const system = rt.system;
    const agentConfig = await loadAgentConfig(
      options.home,
      session.workspaceId ? session.cwd : undefined,
    );
    if (needsNewWorkflow(rt))
      rt.workflow = createWorkflow(ctx, gate, {
        session,
        rt,
        agentConfig,
        web,
        events,
      });
    // 自動圧縮に失敗したら、このターンでは再試行しない(次のターンで再試行する)
    let compactionFailure: string | undefined;
    const result = await rt.workflow!.run(
      {
        prepareContext: options.phase4
          ? async (messages, route, signal, context) => {
              signal.throwIfAborted();
              const limit = route.provider
                .models()
                .find((m) => m.id === route.model)?.contextTokens;
              const prepared = await prepareProviderHistory(messages, {
                provider: route.provider,
                model: route.model,
                signal,
                system: context?.system ?? system,
                tools:
                  context?.tools ?? [...rt.tools!.values()].map((t) => t.spec),
                checkpoint: rt.checkpoint,
                skipCompaction: !!compactionFailure,
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
                await checkpointFile(options.home, sessionId).write(
                  prepared.checkpoint,
                );
                events.record({
                  id: events.nextReceiptId(),
                  sessionId,
                  ts: Date.now(),
                  provider: "harness",
                  kind: "compact",
                  durationMs: 0,
                  summary: `Compacted ${prepared.checkpoint.covered} older messages`,
                });
              }
              if (prepared.failure && !compactionFailure) {
                compactionFailure = prepared.failure;
                emit({
                  type: "notice",
                  sessionId,
                  tone: "warn",
                  message: clean(
                    prepared.fits
                      ? `履歴の自動圧縮ができなかったため、圧縮せずに続けます(${route.model}: ${prepared.failure})。次のターンで再試行します`
                      : `履歴の自動圧縮ができず、コンテキスト上限を超えるため停止します(${route.model}: ${prepared.failure})`,
                  ),
                });
              }
              return {
                messages: prepared.messages,
                ...(!prepared.fits ? { stop: "context_overflow" } : {}),
              };
            }
          : undefined,
        provider: options.provider,
        router: options.providers
          ? new Router(
              options.providers,
              rt.mainConfig?.fallback ?? options.fallback,
              rt.mainConfig?.aliases ?? options.aliases,
            )
          : undefined,
        sessionId,
        onFallback: async (route) => {
          events.activeProvider = route.provider.id;
          const latest = ctx.sessions.get(sessionId) ?? session;
          await ctx.sessions.save({
            ...latest,
            model: route.model,
            effort: route.reasoning?.effort ?? latest.effort,
          });
          emit({
            type: "error",
            sessionId,
            message: `↻ fallback: ${route.model}`,
          });
          await ctx.emitState();
        },
        model: session.model,
        reasoning: { effort: session.effort },
        // 各周の STEP 1 で、このセッションの最新のモデルを読む
        current: () => {
          const latest = ctx.sessions.get(sessionId) ?? session;
          events.activeProvider =
            resolveModel(latest.model)?.provider ?? options.provider.id;
          return {
            model: latest.model,
            reasoning: { effort: latest.effort },
          };
        },
        system,
        messages: rt.messages,
        tools: rt.tools!,
        redact: clean,
        checkpoint: fileCheckpoint,
        sleep: options.sleep,
        permission: async (call, signal) => {
          const started = Date.now();
          const allowed = await gate.ask({
            session,
            rt,
            call,
            receiptId: events.receiptByCall.get(call.id),
            signal,
          });
          if (options.phase4) {
            const receipt: Receipt = {
              id: events.nextReceiptId(),
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
            events.record(receipt);
          }
          return allowed;
        },
        onEvent: events.onEvent,
      },
      abort.signal,
    );
    events.flush();
    rt.messages = result.messages;
    stopCause = result.stopCause;
  } catch {
    events.flush();
    stopCause = abort.signal.aborted ? "aborted" : "step_failed";
    if (!abort.signal.aborted)
      emit({ type: "error", sessionId, message: "内部エラーで停止しました" });
  }
  await finishTurn(ctx, session, rt, events, llmStopCause() ?? stopCause);
}

/**
 * /mcp の表示と操作(§25.8)。MCP をまだ準備していなければ、ここで準備する(承認の確認が出る)。
 * モデルには送らず、履歴にも残さない
 */
export async function runMcpCommand(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  text: string,
): Promise<void> {
  const { emit } = ctx.options;
  const abort = new AbortController();
  rt.abort = abort;
  emit({ type: "turn", sessionId: session.id, status: "running" });
  try {
    const usage = mcpCommandError(text);
    if (usage)
      emit({
        type: "notice",
        sessionId: session.id,
        tone: "warn",
        message: usage,
      });
    else {
      await prepareRuntime(ctx, gate, session, rt, abort.signal);
      await handleMcpCommand(ctx, gate, session, rt, text, abort.signal);
    }
  } catch {
    if (!abort.signal.aborted)
      emit({
        type: "notice",
        sessionId: session.id,
        tone: "warn",
        message: "MCP の操作に失敗しました",
      });
  }
  rt.abort = undefined;
  rt.pending = undefined;
  rt.status = "idle";
  emit({ type: "turn", sessionId: session.id, status: "idle" });
  if (rt.closing) ctx.dropRuntime(session.id);
  await ctx.emitState();
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
  } catch {
    emit({ type: "error", sessionId, message: "履歴の保存に失敗しました" });
  }
  rt.abort = undefined;
  rt.pending = undefined;
  rt.status = "idle";
  const notice = STOP_NOTICE[stopCause];
  if (
    stopCause === "authentication" &&
    !ctx.options.fake &&
    (events.activeProvider === "claude" || events.activeProvider === "codex")
  )
    ctx.options.authentication?.reject(events.activeProvider);
  if (notice && stopCause !== "aborted")
    if (["agent_stopped", "awaiting_user"].includes(stopCause))
      emit({ type: "notice", sessionId, tone: "dim", message: notice });
    else emit({ type: "error", sessionId, message: notice });
  emit({ type: "turn", sessionId, status: "idle", stopCause });
  if (rt.closing) ctx.dropRuntime(sessionId);
  await ctx.emitState();
}
