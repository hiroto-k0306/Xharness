import { memoryHash, memoryScope } from "./memory-sources.js";
import {
  historyText,
  projectHistoryAccess,
  type HistoryScope,
} from "../tools/project-history.js";
import { evaluateTrace, compareEvaluations } from "./evaluation.js";
import { readTraceReplay } from "./report-trace.js";
import { ImprovementFault } from "./improvement-document.js";
import {
  improvementPrompt,
  type Improvement,
  type ImprovementResult,
  type ImprovementRow,
} from "../../shared/improvements.js";
export async function loadImprovementTask(
  scope: HistoryScope,
  e: Improvement,
  r: Omit<ImprovementResult, "traceHash">,
) {
  const access = projectHistoryAccess(scope),
    pin = await memoryScope(scope).identity();
  if (!(await access.eligible(scope.sessions.get(r.sessionId), true)))
    throw new ImprovementFault(
      "評価会話のproject境界・保存状態を確認してください。",
    );
  const settled = await scope.sessions.evaluationTask(r.sessionId);
  if (
    settled?.id !== r.taskId ||
    settled.settled !== true ||
    settled.recoveryRequired
  )
    throw new ImprovementFault("未確定または別タスクの評価です。");
  const history = await scope.sessions.historyRecords(r.sessionId, pin.home);
  const users = history?.records.filter((r) => r.message.role === "user");
  const version = e.versions.find((v) => v.id === r.versionId),
    c = e.cases.find((c) => c.id === r.caseId);
  if (
    !version ||
    !c ||
    !history ||
    history.truncated ||
    users?.length !== 1 ||
    users[0]!.message.content.some((b) => b.type !== "text") ||
    users[0]!.message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("") !== improvementPrompt(e, version, c)
  )
    throw new ImprovementFault(
      "固定課題・候補版の依頼と保存済み入力が一致しません。新規会話で評価してください。",
    );
  const trace = await readTraceReplay(pin.home, r.sessionId, scope.clean),
    tasks = evaluateTrace(trace);
  if (tasks.length !== 1 || !tasks[0] || tasks[0].taskId !== r.taskId)
    throw new ImprovementFault("単一固定課題の記録が必要です。");
  const task = tasks[0],
    compared = compareEvaluations([
      {
        task,
        caseId: c.id,
        taskType: c.taskType,
        difficulty: c.difficulty,
        criteriaVersion: c.criteria,
        environment: c.environment,
        configuration: `${version.name}/${version.hash}`,
        assessment: {
          source: "explicit_evaluation",
          passed: r.passed,
          evidence: historyText(r.evidence, scope.clean),
        },
      },
    ])[0]!.runs[0]!;
  return { task, compared, traceHash: memoryHash(trace) };
}
export async function improvementRow(
  scope: HistoryScope,
  e: Improvement,
  r: ImprovementResult,
): Promise<ImprovementRow> {
  const base: ImprovementRow = {
    versionId: r.versionId,
    caseId: r.caseId,
    sessionId: r.sessionId,
    taskId: r.taskId,
    quality: false,
    valid: false,
    note: "記録変更・削除・未確定",
    evidence: historyText(r.evidence, scope.clean),
    input: null,
    output: null,
    inputCoverage: "不明",
    outputCoverage: "不明",
    elapsedMs: null,
    models: [],
    resourceComparable: false,
  };
  try {
    const { task, compared, traceHash } = await loadImprovementTask(
      scope,
      e,
      r,
    );
    if (traceHash !== r.traceHash) return base;
    return {
      ...base,
      valid: true,
      quality: compared.qualitySatisfied && !task.recordingIncomplete,
      note: task.simulatedCalls
        ? "模擬・参考値。本番の優越は未検証"
        : compared.resourceComparable
          ? "取得済み実測。モデル・effortも照合"
          : "欠測・参考値",
      input: task.metrics.input.known,
      output: task.metrics.output.known,
      inputCoverage: `${task.metrics.input.measuredCalls}/${task.calls.length}`,
      outputCoverage: `${task.metrics.output.measuredCalls}/${task.calls.length}`,
      elapsedMs: task.elapsedMs,
      models: [
        ...new Set(
          task.calls.map(
            (c) => `${c.provider}/${c.model ?? "不明"}/${c.effort ?? "不明"}`,
          ),
        ),
      ],
      resourceComparable: compared.resourceComparable,
    };
  } catch {
    return base;
  }
}
