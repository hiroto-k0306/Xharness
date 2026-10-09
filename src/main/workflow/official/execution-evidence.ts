import type { WorkflowRecord } from "./runtime.js";

export function measuredHead(head: string) {
  return /^0+$/.test(head) ? null : head;
}

/** Facts only: never include prompts, responses, credentials or thinking. */
export function executionEvidence(record: WorkflowRecord) {
  const dag = record.nativeDagWorkspace;
  const sourceBaseHead = dag ? measuredHead(dag.sourceBase) : null;
  const ownedIntegrationHead = dag?.integration?.head
    ? measuredHead(dag.integration.head)
    : null;
  const calls = record.calls.map((call) => ({
    phase: call.phase,
    status: call.status,
    dispatched: "dispatched" in call ? call.dispatched : null,
  }));
  return {
    workflowId: record.id,
    status: record.status,
    sourceCwd:
      dag?.source ?? record.project?.source ?? record.sourceCwd ?? null,
    sourceBaseHead,
    ownedIntegrationHead,
    executionCwd: record.cwd,
    measuredHead:
      ownedIntegrationHead ??
      (record.nativeWork ? null : measuredHead(record.head)),
    headExplanation: ownedIntegrationHead
      ? "測定HEADは所有する隔離Git worktreeの統合コミットです。source baseは元リポジトリの開始コミットで、利用者のブランチは変更していません。"
      : record.nativeWork
        ? "この記録のbase/headはファイル比較digestです。Git HEADは測定していません。"
        : "ゼロのHEADは初期値で未測定です。Gitリポジトリが存在しない証拠ではありません。",
    calls,
    confirmedDispatches: calls.filter((c) => c.dispatched === true).length,
    unmeasuredDispatches: calls.filter((c) => c.dispatched === null).length,
    error: record.error ?? null,
  };
}
