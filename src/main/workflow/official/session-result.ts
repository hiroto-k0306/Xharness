import type { WorkflowRecord } from "./runtime.js";
import { executionEvidence } from "./execution-evidence.js";

/** The exact public answer persisted in the ordinary session, never hidden model text. */
export function officialSessionSummary(record: WorkflowRecord, task: boolean) {
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
