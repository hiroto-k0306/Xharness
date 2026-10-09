import { memoryHash, memoryScope } from "./memory-sources.js";
import {
  historyText,
  projectHistoryAccess,
  type HistoryScope,
} from "../tools/project-history.js";
import {
  evaluateTrace,
  compareEvaluations,
  type TaskEvaluation,
} from "./evaluation.js";
import { officialHandoffSource } from "./handoff-official.js";
import type { WorkflowRecord } from "../workflow/official/runtime.js";
import { normalizeTokens } from "../providers/token-usage.js";
import { readTraceReplay } from "./report-trace.js";
import { ImprovementFault } from "./improvement-document.js";
import {
  improvementPrompt,
  type Improvement,
  type ImprovementResult,
  type ImprovementRow,
} from "../../shared/improvements.js";

/** Passive saved evidence only; never starts an agent to evaluate a result. */
export async function resolveImprovementTaskId(
  scope: HistoryScope,
  sessionId: string,
) {
  const selected = { ...scope, sessionId };
  const pin = await memoryScope(selected).identity();
  if (
    !(await projectHistoryAccess(selected).eligible(
      scope.sessions.get(sessionId),
      true,
    ))
  )
    throw new ImprovementFault(
      "評価会話のproject境界・保存状態を確認してください。",
    );
  const history = await scope.sessions.historyRecords(sessionId, pin.home);
  if (!history || history.truncated)
    throw new ImprovementFault("保存済み会話の欠落を確認してください。");
  const official = await officialHandoffSource(
    selected,
    pin.home,
    history.records.map((r) => r.message),
  );
  return (
    official?.taskId ?? (await scope.sessions.evaluationTask(sessionId))?.id
  );
}

function officialEvaluation(record: WorkflowRecord): TaskEvaluation {
  if (typeof record.simulated !== "boolean")
    throw new ImprovementFault("模擬・本番の記録区分を確認できません。");
  const keys = [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "reasoning",
    "total",
  ] as const;
  const missing: ReturnType<typeof normalizeTokens> = {
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    reasoning: null,
    total: null,
  };
  const calls = record.calls.map((call) => {
    if (call.status === "running")
      throw new ImprovementFault("実行中の記録は評価できません。");
    if (
      typeof call.dispatched !== "boolean" ||
      !["claude", "codex"].includes(call.provider) ||
      !Array.isArray(call.observedModels) ||
      call.observedModels.some(
        (model) =>
          typeof model !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(model),
      ) ||
      (call.usage != null &&
        (typeof call.usage.complete !== "boolean" ||
          ![
            "query-pipeline",
            "partial-main-loop",
            "main-loop",
            "thread-cumulative",
          ].includes(call.usage.scope) ||
          call.usage.measurement?.provider !== call.provider))
    )
      throw new ImprovementFault("公式呼出の送信・usage記録を確認できません。");
    const measured =
      call.dispatched && call.usage && call.usage.scope !== "thread-cumulative"
        ? call.usage.measurement
        : undefined;
    const tokens = measured ? normalizeTokens(measured) : { ...missing };
    // Thread totals and ambiguous model observations are reference measurements,
    // never a claim that complete, independently comparable calls were measured.
    const complete =
      !!measured &&
      call.usage?.complete === true &&
      call.usage.scope !== "thread-cumulative" &&
      call.observedModels.length === 1 &&
      tokens.input !== null &&
      tokens.output !== null;
    return {
      attemptId: call.requestId,
      spanId: call.requestId,
      agentId: record.id,
      provider: call.provider,
      model:
        call.observedModels.length === 1
          ? call.observedModels[0]!
          : call.observedModels.length > 1
            ? null
            : call.requestedModel,
      effort: call.effort,
      simulated: record.simulated,
      dispatched: call.dispatched,
      complete,
      status: call.status,
      durationMs:
        Number.isFinite(call.elapsedMs) && call.elapsedMs >= 0
          ? call.elapsedMs
          : null,
      tokens,
      ...(measured ? { measurement: measured } : {}),
    };
  });
  const duration =
    Date.parse(record.finishedAt!) - Date.parse(record.startedAt);
  const metrics = Object.fromEntries(
    keys.map((key) => {
      const values = calls
        .map((call) => call.tokens[key])
        .filter((v): v is number => v !== null);
      return [
        key,
        {
          known: values.length ? values.reduce((a, b) => a + b, 0) : null,
          measuredCalls: values.length,
        },
      ];
    }),
  ) as TaskEvaluation["metrics"];
  return {
    taskId: record.id,
    outcome: "completed",
    stopCause: "official_workflow_complete",
    elapsedMs: calls.every((c) => c.durationMs !== null)
      ? calls.reduce((sum, c) => sum + c.durationMs!, 0)
      : null,
    wallClockMs: duration,
    runs: 1 + (record.resumed ?? 0),
    calls,
    metrics,
    completeUsageCalls: calls.filter((c) => c.complete).length,
    simulatedCalls: record.simulated ? calls.length : 0,
    dispatchedCalls: calls.filter((c) => c.dispatched).length,
    reviewAttempts: record.reviews.length,
    correctionRounds: record.correctionRounds,
    evidence: [
      {
        spanId: record.id,
        source: "harness",
        kind: "official_workflow",
        result: {
          status: record.status,
          checks: record.checks,
          reviews: record.reviews,
        },
      },
    ],
    recordingIncomplete: false,
  };
}
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
  const official = await officialHandoffSource(
    { ...scope, sessionId: r.sessionId },
    pin.home,
    history!.records.map((r) => r.message),
  );
  let task: TaskEvaluation;
  let traceHash: string;
  let measuredAt: number | null;
  if (official) {
    if (official.taskId !== r.taskId)
      throw new ImprovementFault("未確定または別タスクの評価です。");
    task = officialEvaluation(official.evidence.record);
    traceHash = memoryHash({ official: official.evidence, history });
    measuredAt = Date.parse(official.completedAt);
  } else {
    const settled = await scope.sessions.evaluationTask(r.sessionId);
    if (
      settled?.id !== r.taskId ||
      settled.settled !== true ||
      settled.recoveryRequired
    )
      throw new ImprovementFault("未確定または別タスクの評価です。");
    const trace = await readTraceReplay(pin.home, r.sessionId, scope.clean);
    const tasks = evaluateTrace(trace);
    if (tasks.length !== 1 || !tasks[0] || tasks[0].taskId !== r.taskId)
      throw new ImprovementFault("単一固定課題の記録が必要です。");
    task = tasks[0];
    traceHash = memoryHash(trace);
    const endings = trace!.records
      .filter((r) => r.kind === "task" && r.phase === "end")
      .map((r) => Date.parse(r.at));
    const latest = Math.max(...endings);
    measuredAt = Number.isFinite(latest) ? latest : null;
  }
  const compared = compareEvaluations([
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
  return {
    task,
    compared,
    traceHash,
    measuredAt,
  };
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
