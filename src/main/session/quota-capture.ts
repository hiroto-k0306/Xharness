import { loadAgentConfig } from "../agents/definitions.js";
import { type ControllerContext, type Runtime } from "./context.js";
import { type StoredSession } from "./store.js";
import { type QuotaPauses } from "./quota-pause.js";
import { resumeConditions, resumeHash } from "./resume-conditions.js";

type Evidence = Parameters<NonNullable<ControllerContext["quotaPaused"]>>[2];
/** Absolute reset is inferred only from the latest failed attempt's explicit data. */
export function quotaWait(rate: Evidence["rate"]) {
  const exhausted = (rate.windows ?? []).filter(
    (window) => (window.usedPercent ?? 0) >= 100,
  );
  const resets = exhausted.map((window) =>
    window.resetAt === undefined ? NaN : Date.parse(window.resetAt),
  );
  const retry = rate.retryAfterSec;
  const nextCheckAt = resets.some((time) => !Number.isFinite(time))
    ? undefined
    : Number.isFinite(retry) && retry! >= 0
      ? Math.max(rate.receivedAt + retry! * 1000, ...resets)
      : resets.length
        ? Math.max(rate.receivedAt, ...resets)
        : undefined;
  const scope =
    rate.scope === "5h" || rate.scope === "7d"
      ? rate.scope
      : exhausted.some((window) => window.windowMinutes === 10080)
        ? "7d"
        : exhausted.some((window) => window.windowMinutes === 300)
          ? "5h"
          : "provider-pool-unknown";
  return {
    nextCheckAt: Number.isFinite(nextCheckAt) ? nextCheckAt : undefined,
    scope,
  };
}
export async function captureQuotaPause(
  ctx: ControllerContext,
  pauses: QuotaPauses,
  session: StoredSession,
  rt: Runtime,
  evidence: Evidence,
) {
  let blocker = !evidence.saved
    ? "保存が未確定です。レポートを確認してください。"
    : evidence.unsafe
      ? "途中応答・ツール・fallback・エラーの結果を確認してください。自動復元しません。"
      : rt.always.size ||
          rt.sessionRules?.length ||
          rt.trustedSession ||
          rt.trustDeclined
        ? "一時的な権限・信頼の復元は未対応です。手動で確認してください。"
        : (rt.searchBudget?.used ?? 0) > 0
          ? "MCP・Web検索の状態復元は未対応です。手動で確認してください。"
          : undefined;
  let conditionsHash = "unavailable";
  try {
    const agents = await loadAgentConfig(
      ctx.options.home,
      session.workspaceId ? session.cwd : undefined,
      !ctx.workspaceRoot(session) ||
        (await ctx.trust.isTrusted(ctx.workspaceRoot(session)!)),
    );
    if (agents.workflow.mode !== "off" || agents.hooks?.length)
      blocker ??= "通常会話(off)・hookなしの場合だけ自動復元できます。";
    conditionsHash = await resumeConditions(ctx, session);
  } catch {
    blocker ??=
      "作業場所・設定の前提を確認できません。手動で確認してください。";
  }
  if (
    !session.premiseHash ||
    !rt.premises ||
    !rt.evaluationTaskId ||
    rt.messages.at(-1)?.role !== "user"
  )
    blocker ??= "安全な会話チェックポイントを確認できません。";
  if (rt.abort?.signal.aborted || rt.closing)
    blocker = "停止・閉じる操作を受けたため自動再開しません。";
  const wait = quotaWait(evidence.rate);
  await pauses.put({
    sessionId: session.id,
    provider: evidence.rate.provider,
    model: evidence.rate.model,
    observed: {
      receivedAt: evidence.rate.receivedAt,
      retryAfterSec: evidence.rate.retryAfterSec,
      scope: evidence.rate.scope,
      windows: evidence.rate.windows,
    },
    ...wait,
    eligible: !blocker,
    reason:
      blocker ??
      (wait.nextCheckAt === undefined
        ? "回復時刻が不明です。手動再確認を選ぶか、新しい指示を入力してください。"
        : "枠待ちを保存しました。自動再開は既定OFFです。"),
    snapshot: {
      taskId: rt.evaluationTaskId,
      originalTask: { userMessageIndex: rt.messages.length - 1 },
      phase: "connection-experiment",
      unfinished: ["last accepted user request"],
      effort: session.effort,
      premiseHash: session.premiseHash,
      messagesHash: resumeHash(rt.messages),
      messageCount: rt.messages.length,
      checkpointHash: resumeHash(rt.checkpoint ?? null),
      conditionsHash,
      cwd: session.cwd,
      workspaceId: session.workspaceId,
      readOnly: session.readOnly,
      permissionMode: session.permissionMode,
      results: (rt.receipts ?? []).slice(-16).map((receipt) => receipt.id),
      approval: "current-policy-only",
    },
  });
  if (rt.abort?.signal.aborted || rt.closing)
    await pauses.cancel(
      session.id,
      "明示停止・閉じる操作により再開を取り消しました。",
    );
}
