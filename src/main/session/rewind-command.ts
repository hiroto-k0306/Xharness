import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { FileCheckpointStore } from "../checkpoints/store.js";
import { loadProjectConfig } from "../config/project.js";
import { type ControllerContext, type Runtime } from "./context.js";
import { type StoredSession } from "./store.js";
import { type Message } from "../core/types.js";
import { type RewindChoice } from "../../shared/rewind.js";
import { itemsFromMessages } from "./transcript.js";
import { ReceiptStore } from "./receipts.js";

export function rewindRecord(
  keep: number,
  scope: RewindChoice["scope"],
  restored: number,
  skipped: number,
): Message {
  return {
    role: "user",
    ...(scope !== "code" ? { meta: { rewind: { keep } } } : {}),
    content: [
      {
        type: "text",
        text: `[巻き戻し] 対象=${scope}、復元${restored}件、除外${skipped}件。Bashによる変更は追跡・復元していません。現在のファイルを読み直して作業してください。`,
      },
    ],
  };
}
export async function runRewind(
  ctx: ControllerContext,
  session: StoredSession,
  rt: Runtime,
  count: number,
): Promise<void> {
  const abort = new AbortController();
  rt.abort = abort;
  const { emit, home } = ctx.options;
  const sessionId = session.id;
  emit({ type: "turn", sessionId, status: "running" });
  try {
    const files = new FileCheckpointStore(home);
    const config = await loadProjectConfig(home);
    await files.purge(config.checkpoints?.retentionDays ?? 30);
    const plan = await files.preview(sessionId, count);
    if (plan.messages > rt.messages.length)
      throw new Error("会話の位置が不正です。");
    const requestId = randomUUID();
    rt.status = "ask";
    await ctx.emitState();
    const choice = await new Promise<RewindChoice | null>((resolve) => {
      const done = (choice: RewindChoice | null) => {
        abort.signal.removeEventListener("abort", cancel);
        rt.rewindPrompt = undefined;
        resolve(choice);
      };
      const cancel = () => done(null);
      rt.rewindPrompt = { requestId, resolve: done };
      abort.signal.addEventListener("abort", cancel, { once: true });
      emit({
        type: "rewind_request",
        sessionId,
        requestId,
        preview: {
          ...plan.preview,
          files: plan.preview.files.map((f) => ({
            ...f,
            path: ctx.clean(f.path),
          })),
        },
      });
      if (abort.signal.aborted) cancel();
    });
    if (!choice || abort.signal.aborted) return;
    rt.status = "running";
    if (
      choice.includeConflicts.some(
        (id) =>
          !plan.entries.some(
            (e) => e.id === id && e.conflict && !e.unavailable,
          ),
      )
    )
      throw new Error("対象が不正です。");
    const result = await files.restore(plan, choice, abort.signal);
    const scope = abort.signal.aborted ? "code" : choice.scope;
    const marker = rewindRecord(
      plan.messages,
      scope,
      result.restored.length,
      result.skipped.length,
    );
    await ctx.sessions.append(sessionId, [marker], ctx.clean);
    rt.messages = await ctx.sessions.messages(sessionId);
    rt.persisted = rt.messages.length;
    for (const tool of rt.tools?.values() ?? []) tool.invalidate?.();
    rt.workflow = undefined;
    emit({
      type: "workflow",
      sessionId,
      phase: "off",
      reviewRound: 0,
      items: [],
      findings: [],
    });
    if (scope !== "code") {
      await files.conversationRewound(sessionId, plan, result.restored);
      rt.checkpoint = undefined;
      await rm(join(home, "context", sessionId + ".json"), { force: true });
    }
    const receipt = {
      id: `#${String(++rt.receiptSeq).padStart(4, "0")}`,
      sessionId,
      ts: Date.now(),
      provider: "harness" as const,
      kind: "tool" as const,
      tool: "Rewind",
      decision: "allow" as const,
      durationMs: 0,
      summary: `巻き戻し：復元${result.restored.length}件、除外${result.skipped.length}件`,
      input: { turns: count, scope },
      output: ctx.clean(JSON.stringify(result)),
    };
    await new ReceiptStore(home).append(sessionId, [receipt], ctx.clean);
    (rt.receipts ??= []).push(receipt);
    emit({ type: "receipt", receipt });
    emit({
      type: "transcript",
      sessionId,
      items: itemsFromMessages(rt.messages),
    });
    emit({
      type: "notice",
      sessionId,
      tone: result.skipped.length ? "warn" : "dim",
      message: receipt.summary + "。Bashによる変更は対象外です。",
    });
  } catch {
    emit({
      type: "notice",
      sessionId,
      tone: "warn",
      message:
        "巻き戻しを完了できませんでした。チェックポイントの有無・期限・対象のアクセス権限を確認してください。適用済みのファイルがある場合はレシートと現在の内容を確認してください。",
    });
  } finally {
    rt.rewindPrompt = undefined;
    rt.abort = undefined;
    rt.status = "idle";
    emit({ type: "turn", sessionId, status: "idle" });
    if (rt.closing) ctx.dropRuntime(sessionId);
    await ctx.emitState();
  }
}
