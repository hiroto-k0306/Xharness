import type { WorkflowRecord } from "./runtime.js";

export function measuredHead(head: string) {
  return /^0+$/.test(head) ? null : head;
}

/** Facts only: never include prompts, responses, credentials or thinking. */
export function executionEvidence(record: WorkflowRecord) {
  const calls = record.calls.map((call) => ({
    phase: call.phase,
    status: call.status,
    dispatched: "dispatched" in call ? call.dispatched : null,
  }));
  return {
    workflowId: record.id,
    status: record.status,
    sourceCwd: record.project?.source ?? record.sourceCwd ?? null,
    executionCwd: record.cwd,
    measuredHead: measuredHead(record.head),
    headExplanation:
      "ゼロのHEADは初期値で未測定です。Gitリポジトリが存在しない証拠ではありません。",
    calls,
    confirmedDispatches: calls.filter((c) => c.dispatched === true).length,
    unmeasuredDispatches: calls.filter((c) => c.dispatched === null).length,
    error: record.error ?? null,
  };
}
