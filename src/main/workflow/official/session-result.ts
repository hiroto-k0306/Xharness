import type { WorkflowRecord } from "./runtime.js";
import { executionEvidence } from "./execution-evidence.js";

/** Fixed explanations; never return the SDK's raw error text. */
export function officialFailureMessage(record: WorkflowRecord) {
  const messages: Record<string, string> = {
    "claude-max-turns-exceeded":
      "Claude SDKの内部往復回数の上限に達したため停止しました。自動再送していません。",
    "claude-sdk-budget-exceeded":
      "Claude SDKの予算上限に達したため停止しました。追加課金へ切り替えていません。",
    "claude-structured-output-retries-exceeded":
      "Claude SDKが構造化結果を生成できず、生成の試行上限に達しました。自動再送していません。",
    "claude-sdk-execution-failed":
      "Claude SDKが実行エラーで終了しました。詳細本文は保存していません。",
    "claude-sdk-result-failed":
      "Claude SDKが失敗結果を返しました。詳細本文は保存していません。",
  };
  const last = record.calls.at(-1);
  const legacy =
    record.error === "failed" &&
    last &&
    last.status !== "running" &&
    last.diagnostics?.termination === "error_max_turns";
  return (
    messages[legacy ? "claude-max-turns-exceeded" : (record.error ?? "")] ??
    record.error
  );
}

/** The exact public answer persisted in the ordinary session, never hidden model text. */
export function officialSessionSummary(record: WorkflowRecord, task: boolean) {
  // Local display copy only; existing persisted history is never rewritten.
  record = { ...record, error: officialFailureMessage(record) };
  const preparation = record.project?.preparation;
  const evidence = executionEvidence(record);
  const head = record.nativeWork
    ? `ファイル比較digest ${record.head}（Git HEADではありません）`
    : (evidence.measuredHead ??
      "未測定（初期値からGitの有無は判断できません）");
  const calls = `通信確認済み：${evidence.confirmedDispatches}回 / 送信有無未測定：${evidence.unmeasuredDispatches}件`;
  const location = preparation
    ? preparation.destination === record.cwd
      ? "作業領域を準備しました。元フォルダーへの反映・mainへのマージは別途確認してください。"
      : `作業領域の準備完了は確認できていません。予定先：${preparation.destination}。元フォルダーへの反映は行っていません。`
    : "既存worktreeの場合は、従来の完了操作で変更を確認・反映してください。";
  return (
    record.answer ??
    (task
      ? `公式作業 ${record.status} / ${record.error ?? "テスト・別会社レビューの結果は公式workflowを確認してください。"}\n元の作業場所：${evidence.sourceCwd ?? "未記録"}\n記録の実行場所：${record.cwd}\n記録HEAD／検査digest：${head}\n${calls}\n${location}`
      : `公式質問 ${record.status} / ${record.error ?? "回答を取得できませんでした。再送していません。"}`)
  );
}
