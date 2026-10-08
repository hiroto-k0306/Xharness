import type { WorkflowRecord } from "./runtime.js";

/** The exact public answer persisted in the ordinary session, never hidden model text. */
export function officialSessionSummary(record: WorkflowRecord, task: boolean) {
  return (
    record.answer ??
    (task
      ? `公式作業 ${record.status} / ${record.error ?? "テスト・別会社レビューの結果は公式workflowを確認してください。"}\nセッションの作業場所：${record.cwd}\n記録HEAD：${record.head}\n既存worktreeの場合は、従来の完了操作で変更を確認・反映してください。`
      : `公式質問 ${record.status} / ${record.error ?? "回答を取得できませんでした。再送していません。"}`)
  );
}
