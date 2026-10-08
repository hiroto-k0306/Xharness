import type { WorkflowRecord } from "./runtime.js";

/** The exact public answer persisted in the ordinary session, never hidden model text. */
export function officialSessionSummary(record: WorkflowRecord, task: boolean) {
  const preparation = record.project?.preparation;
  const location = preparation
    ? preparation.destination === record.cwd
      ? "作業領域を準備しました。元フォルダーへの反映・mainへのマージは別途確認してください。"
      : `作業領域の準備完了は確認できていません。予定先：${preparation.destination}。元フォルダーへの反映は行っていません。`
    : "既存worktreeの場合は、従来の完了操作で変更を確認・反映してください。";
  return (
    record.answer ??
    (task
      ? `公式作業 ${record.status} / ${record.error ?? "テスト・別会社レビューの結果は公式workflowを確認してください。"}\n記録の作業場所：${record.cwd}\n記録HEAD／検査digest：${record.head}\n${location}`
      : `公式質問 ${record.status} / ${record.error ?? "回答を取得できませんでした。再送していません。"}`)
  );
}
