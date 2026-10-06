import {
  withSessionTrace,
  withTraceFields,
  traceOperation,
} from "../core/trace.js";
import { TurnEvents } from "./turn-events.js";
import { permissionModeLabels } from "../../shared/permission-modes.js";
import { withSessionCalls } from "./llm-calls.js";
import { LlmBudgetError } from "../core/llm-budget.js";
import { premiseHash, PREMISE_NOTICE } from "./premises.js";
import { loadProjectConfig } from "../config/project.js";
// 設定に関するコマンド: 権限モード、既定モデル(config.yaml の main)、/compact。
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadModelCatalog } from "../config/model-catalog.js";
import { prepareProviderHistory } from "../context/provider-compactor.js";
import { Router } from "../core/router.js";
import { systemPrompt } from "./turn.js";
import {
  type CommandResult,
  type Effort,
  type HarnessCommand,
} from "../../shared/ipc.js";
import { checkpointFile, pad, type ControllerContext } from "./context.js";
import { RECOVERY_NOTICE } from "./store.js";

/** セッションの権限モードを切り替え、その事実をレシートに残す(§9.1) */
export async function setMode(
  ctx: ControllerContext,
  command: Extract<HarnessCommand, { type: "set_mode" }>,
): Promise<CommandResult> {
  const session = ctx.sessions.get(command.sessionId);
  if (!session || (session.readOnly && command.mode !== "plan"))
    return { ok: false, error: "Mode unavailable" };
  await ctx.sessions.save({ ...session, permissionMode: command.mode });
  const rt = await ctx.load(session.id);
  await ctx.record(rt, {
    id: pad(++rt.receiptSeq),
    sessionId: session.id,
    ts: Date.now(),
    provider: "harness",
    kind: "permission",
    durationMs: 0,
    summary: `Mode: ${permissionModeLabels[command.mode]}`,
  });
  await ctx.emitState();
  return { ok: true };
}

/** `~/.xharness/config.yaml` の main.model / main.effort を書き換える。適用した effort を返す */
export async function saveDefaultModel(
  home: string,
  command: Extract<HarnessCommand, { type: "set_default_model" }>,
): Promise<{ ok: true; effort: Effort } | { ok: false; error: string }> {
  const model = loadModelCatalog().find(
    (m) => m.enabled && m.id === command.model,
  );
  if (
    !model ||
    (command.effort && model.efforts && !model.efforts[command.effort])
  )
    return { ok: false, error: "Unavailable model or effort" };
  const path = join(home, "config.yaml");
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
  await mkdir(home, { recursive: true });
  await writeFile(temp, stringify(doc));
  await rename(temp, path);
  return { ok: true, effort };
}

/** /compact: 古い履歴を要約に置き換える(元の履歴は保存したまま) */
export async function compactNow(
  ctx: ControllerContext,
  sessionId: string,
): Promise<CommandResult> {
  const rt = await ctx.load(sessionId);
  if (rt.status !== "idle") return { ok: false, error: "Turn already running" };
  const session = ctx.sessions.get(sessionId);
  if (!session) return { ok: false, error: "Unknown session" };
  // Claim the runtime before any further await, including checkpoint loading.
  const abort = new AbortController();
  let finish: () => void = () => {};
  rt.done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  rt.abort = abort;
  rt.status = "running";
  let stopCause: string | undefined;
  ctx.options.emit({ type: "turn", sessionId, status: "running" });
  const events = new TurnEvents(ctx, session, rt);
  let evaluationTask: Awaited<ReturnType<typeof ctx.sessions.evaluationTask>>;
  let operationId: string | undefined;
  let persisted = false;
  try {
    evaluationTask = await ctx.sessions.evaluationTask(sessionId);
    if (evaluationTask?.recoveryRequired)
      return { ok: false, error: RECOVERY_NOTICE };
    const file = checkpointFile(ctx.options.home, sessionId);
    rt.checkpoint ??= await file.read(undefined);
    abort.signal.throwIfAborted();
    const provider = new Router(
      ctx.options.providers ?? [ctx.options.provider],
    ).provider(session.model);
    // Codex summaries use an independent fixed system and strip reasoning.
    // Claude compact reuses the original prefix, which must be validated first.
    if (
      provider.id === "claude" &&
      rt.messages.some((m) => m.role === "assistant") &&
      (!rt.premises || session.premiseHash !== premiseHash(rt.premises))
    )
      return { ok: false, error: PREMISE_NOTICE };
    const limits = (await loadProjectConfig(ctx.options.home)).limits;
    operationId = evaluationTask?.id ?? randomUUID();
    await ctx.sessions.recordEvaluationTask(
      sessionId,
      operationId,
      evaluationTask?.active ?? false,
      false,
    );
    const result = await withSessionCalls(
      {
        home: ctx.options.home,
        id: sessionId,
        limits,
        abort,
        changed: (calls) => {
          rt.llmCalls = calls;
          void ctx.emitState();
        },
      },
      async (budget) => {
        const prepared = await withSessionTrace(
          ctx.options.home,
          sessionId,
          ctx.clean,
          async () =>
            withTraceFields(
              {
                taskId: evaluationTask?.active ? evaluationTask.id : undefined,
              },
              () =>
                traceOperation("step", "manual_compact", {}, async () =>
                  prepareProviderHistory(rt.messages, {
                    onAuthRefresh: events.onEvent,
                    provider,
                    model: session.model,
                    signal: abort.signal,
                    system:
                      rt.premises?.system ??
                      rt.system ??
                      (await systemPrompt(
                        ctx,
                        session.cwd,
                        !session.workspaceId,
                        rt.config,
                        session.fileLinkGuidanceVersion === 1,
                      )),
                    tools:
                      rt.premises?.tools ??
                      [...(rt.tools?.values() ?? [])].map((t) => t.spec),
                    checkpoint: rt.checkpoint,
                    threshold: 0.8,
                    force: true,
                  }),
                ),
            ),
          {
            onWarning: (message) =>
              ctx.options.emit({
                type: "notice",
                tone: "warn",
                sessionId,
                message,
              }),
          },
        );
        if (budget.stopCause) throw new LlmBudgetError(budget.stopCause);
        return prepared;
      },
    );
    if (result.checkpoint) {
      rt.checkpoint = result.checkpoint;
      await file.write(result.checkpoint);
    }
    if (result.compacted)
      await ctx.record(rt, {
        id: pad(++rt.receiptSeq),
        sessionId,
        ts: Date.now(),
        provider: "harness",
        kind: "compact",
        durationMs: 0,
        summary: "Manual compact",
      });
    await Promise.all(events.receiptWrites);
    await ctx.sessions.recordEvaluationTask(
      sessionId,
      operationId,
      evaluationTask?.active ?? false,
      true,
    );
    persisted = true;
    ctx.options.emit({
      type: "notice",
      tone: "dim",
      sessionId,
      message: result.compacted
        ? "古い履歴を圧縮しました（元の履歴は保存済み）"
        : "圧縮できる古い履歴がありません",
    });
    return { ok: true };
  } catch (error) {
    if (abort.signal.aborted && !(error instanceof LlmBudgetError)) {
      stopCause = "aborted";
      return {
        ok: false,
        error: "圧縮を中断しました。元の履歴を維持しています。",
      };
    }
    if (error instanceof LlmBudgetError) {
      stopCause = error.reason;
      return {
        ok: false,
        error:
          "通信回数の上限または保存先を確認してください。元の履歴を維持しています。",
      };
    }
    return { ok: false, error: "圧縮に失敗しました。元の履歴を維持しています" };
  } finally {
    // Failure before a known outcome remains fenced; no replay of the operation.
    if (operationId && !persisted)
      ctx.options.emit({
        type: "notice",
        sessionId,
        tone: "warn",
        message: RECOVERY_NOTICE,
      });
    await Promise.all(events.receiptWrites).catch(() => {
      ctx.options.emit({
        type: "notice",
        sessionId,
        tone: "warn",
        message: "認証更新レシートの保存に失敗しました。",
      });
    });
    rt.status = "idle";
    rt.abort = undefined;
    ctx.options.emit({ type: "turn", sessionId, status: "idle", stopCause });
    if (rt.closing) ctx.dropRuntime(sessionId);
    finish();
    await ctx.emitState();
  }
}
