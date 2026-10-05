import { type TraceRecord } from "../core/trace.js";
import {
  normalizeTokens,
  tokenMeasurement,
  type TokenMeasurement,
  type TokenTotals,
} from "../providers/token-usage.js";
import { type TraceReplay } from "./report-trace.js";

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const parse = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
};
export interface Metric {
  /** Sum of measured values only. null when nothing was measured. */
  known: number | null;
  measuredCalls: number;
}
export interface EvaluationCall {
  attemptId: string;
  spanId: string;
  agentId: string;
  provider: string;
  model: string | null;
  effort: string | null;
  simulated: boolean;
  dispatched: boolean | null;
  complete: boolean;
  status: string;
  durationMs: number | null;
  tokens: TokenTotals;
  measurement?: TokenMeasurement;
}
export interface QualityEvidence {
  spanId: string;
  source: "harness" | "model_review" | "command_execution" | "configured_check";
  kind: string;
  result: unknown;
}
export interface TaskEvaluation {
  taskId: string;
  outcome: "completed" | "failed" | "interrupted" | "unknown";
  stopCause: string | null;
  elapsedMs: number | null;
  wallClockMs: number | null;
  runs: number;
  calls: EvaluationCall[];
  metrics: Record<keyof TokenTotals, Metric>;
  completeUsageCalls: number;
  simulatedCalls: number;
  dispatchedCalls: number;
  reviewAttempts: number;
  correctionRounds: number;
  evidence: QualityEvidence[];
  recordingIncomplete: boolean;
  /** Local reference reads, separate from quality/test evidence and model usage. */
  skillReads?: {
    spanId: string;
    tool: string;
    success: boolean;
    selection: unknown;
    references: unknown;
    budget: unknown;
    limits: unknown;
    error: unknown;
  }[];
}
const keys: (keyof TokenTotals)[] = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "total",
];
const emptyTokens = (): TokenTotals => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  total: null,
});
function duration(start: TraceRecord, end?: TraceRecord): number | null {
  const value = end ? Date.parse(end.at) - Date.parse(start.at) : NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function outcome(reason: unknown): TaskEvaluation["outcome"] {
  if (typeof reason !== "string") return "unknown";
  if (["end_turn", "workflow_complete", "reported_done"].includes(reason))
    return "completed";
  if (["aborted", "task_stopped", "awaiting_user"].includes(reason))
    return "interrupted";
  return "failed";
}

/** Trace spans are authoritative; receipts are never added again as token usage. */
export function evaluateTrace(trace?: TraceReplay): TaskEvaluation[] {
  if (!trace) return [];
  const starts = [
    ...new Map(
      trace.records
        .filter((r) => r.phase === "start")
        .map((r) => [
          `${r.kind}:${r.agentId}:${r.kind === "llm" ? (r.attemptId ?? r.id) : r.id}`,
          r,
        ]),
    ).values(),
  ];
  const ends = new Map(
    trace.records.filter((r) => r.phase === "end").map((r) => [r.id, r]),
  );
  const roots = starts.filter((r) => r.kind === "task");
  const groups = new Map<string, TraceRecord[]>();
  for (const root of roots) {
    const key =
      typeof object(root.input).taskId === "string"
        ? String(object(root.input).taskId)
        : root.id;
    groups.set(key, [...(groups.get(key) ?? []), root]);
  }
  return [...groups].map(([taskId, runs]) => {
    const root = runs[0]!;
    const last = runs.at(-1)!;
    const records = starts.filter((r) => r.taskId === taskId);
    const calls: EvaluationCall[] = records
      .filter((r) => r.kind === "llm")
      .map((start) => {
        const end = ends.get(start.id);
        const output = object(end?.output);
        const done = list(output.events)
          .map(object)
          .find((e) => e.type === "message_done");
        const usage = object(done?.usage ?? output.usage);
        const supplied = object(output.tokenMeasurement ?? usage.measurement);
        let measurement: TokenMeasurement | undefined;
        if (["claude", "codex"].includes(String(supplied.provider)))
          measurement = tokenMeasurement(
            supplied.provider as "claude" | "codex",
            supplied.raw,
          );
        let tokens = measurement ? normalizeTokens(measurement) : emptyTokens();
        // Old receipts / fake usage keep their known input/output; semantics of total are unknown.
        if (!measurement) {
          const valid = (v: unknown) =>
            Number.isSafeInteger(v) && (v as number) >= 0
              ? (v as number)
              : null;
          tokens = {
            ...tokens,
            input:
              start.label === "claude"
                ? normalizeTokens(
                    tokenMeasurement("claude", {
                      input_tokens: usage.inputTokens,
                      cache_read_input_tokens: usage.cacheReadTokens,
                      cache_creation_input_tokens: usage.cacheWriteTokens,
                    }),
                  ).input
                : valid(usage.inputTokens),
            output: valid(usage.outputTokens),
          };
        }
        const request = object(object(start.input).internal);
        return {
          attemptId: start.attemptId ?? start.id,
          spanId: start.id,
          agentId: start.agentId,
          provider: start.label,
          model: typeof request.model === "string" ? request.model : null,
          effort:
            typeof object(request.reasoning).effort === "string"
              ? String(object(request.reasoning).effort)
              : null,
          simulated: start.simulated === true,
          dispatched:
            typeof output.dispatched === "boolean" ? output.dispatched : null,
          complete: !!done || output.usageComplete === true,
          status: end?.status ?? "未終了",
          durationMs: duration(start, end),
          tokens,
          measurement,
        };
      });
    const evidence: QualityEvidence[] = [];
    const skillReads: NonNullable<TaskEvaluation["skillReads"]> = [];
    let reviewAttempts = 0;
    let correctionRounds = 0;
    for (const start of records) {
      const end = ends.get(start.id);
      const output = object(end?.output);
      if (
        start.kind === "tool" &&
        ["ListProjectSkills", "LoadProjectSkill"].includes(start.label)
      ) {
        const result = object(parse(output.content));
        const metadata = (v: unknown) => {
          const e = object(v);
          return {
            name: e.name,
            source: e.source,
            hash: e.hash,
            fileBytes: e.fileBytes,
          };
        };
        skillReads.push({
          spanId: start.id,
          tool: start.label,
          success: !!end && !output.isError && result.formatVersion === 1,
          selection: start.label === "LoadProjectSkill" ? start.input : null,
          references:
            start.label === "LoadProjectSkill"
              ? [metadata(result.entry)]
              : list(result.entries).map(metadata),
          budget: result.budget ?? null,
          limits: result.limits ?? null,
          error: result.error ?? null,
        });
      }
      if (start.kind === "tool" && start.label === "RequestReview") {
        reviewAttempts++;
        const result = object(parse(output.content));
        if (!output.isError && result.phase === "implement") correctionRounds++;
        evidence.push({
          spanId: start.id,
          source: "model_review",
          kind: "RequestReview",
          result: end?.output ?? null,
        });
      }
      if (start.kind === "tool" && start.label === "Bash")
        evidence.push({
          spanId: start.id,
          source: "command_execution",
          kind: "Bash",
          result: { input: start.input, output: end?.output ?? null },
        });
      if (start.kind === "tool" && start.label === "WaveCheck")
        evidence.push({
          spanId: start.id,
          source: "configured_check",
          kind: "WaveCheck",
          result: { input: start.input, output: end?.output ?? null },
        });
    }
    const end = ends.get(last.id);
    const latestTimedEnd = [
      end,
      ...records
        .filter((r) => r.label === "manual_compact")
        .map((r) => ends.get(r.id)),
    ]
      .filter((r): r is TraceRecord => !!r)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .at(-1);
    const stopCause = object(end?.output).stopCause;
    evidence.unshift(
      ...runs.map((r): QualityEvidence => ({
        spanId: r.id,
        source: "harness",
        kind: "termination",
        result: object(ends.get(r.id)?.output).stopCause ?? null,
      })),
    );
    const metrics = Object.fromEntries(
      keys.map((key) => {
        const values = calls.flatMap((c) =>
          c.tokens[key] === null ? [] : [c.tokens[key]!],
        );
        return [
          key,
          {
            known: values.length ? values.reduce((n, v) => n + v, 0) : null,
            measuredCalls: values.length,
          },
        ];
      }),
    ) as Record<keyof TokenTotals, Metric>;
    return {
      taskId,
      outcome:
        stopCause === "end_turn" &&
        typeof object(end?.output).workflowPhase === "string" &&
        !["off", "complete"].includes(String(object(end?.output).workflowPhase))
          ? "interrupted"
          : outcome(stopCause),
      stopCause: typeof stopCause === "string" ? stopCause : null,
      elapsedMs: [
        ...runs,
        ...records.filter((r) => r.label === "manual_compact"),
      ].every((r) => duration(r, ends.get(r.id)) !== null)
        ? [
            ...runs,
            ...records.filter((r) => r.label === "manual_compact"),
          ].reduce((n, r) => n + duration(r, ends.get(r.id))!, 0)
        : null,
      wallClockMs: duration(root, latestTimedEnd),
      runs: runs.length,
      calls,
      metrics,
      completeUsageCalls: calls.filter(
        (c) => c.complete && c.tokens.total !== null,
      ).length,
      simulatedCalls: calls.filter((c) => c.simulated).length,
      dispatchedCalls: calls.filter(
        (c) => c.dispatched === true && !c.simulated,
      ).length,
      reviewAttempts,
      correctionRounds,
      evidence,
      skillReads,
      recordingIncomplete:
        !!trace.skipped ||
        !!trace.omittedFiles ||
        runs.some((r) => !ends.has(r.id)) ||
        records.some(
          (r) =>
            !ends.has(r.id) ||
            object(ends.get(r.id)?.output).truncated === true,
        ),
    };
  });
}

/** Unassigned session work is never guessed into the last completed task. */
export function evaluateSessionCommon(
  trace?: TraceReplay,
): TaskEvaluation | undefined {
  const records =
    trace?.records.filter((r) => !r.taskId && r.kind !== "task") ?? [];
  if (!records.some((r) => r.kind === "llm" && r.phase === "start"))
    return undefined;
  const taskId = "session-common";
  const root: TraceRecord = {
    id: taskId,
    sequence: 1,
    phase: "start",
    kind: "task",
    agentId: taskId,
    label: taskId,
    at: "",
    input: { taskId },
  };
  const evaluation = evaluateTrace({
    ...trace!,
    records: [
      root,
      { ...root, phase: "end" },
      ...records.map((r) => ({ ...r, taskId })),
    ],
  })[0]!;
  evaluation.elapsedMs = evaluation.calls.every((c) => c.durationMs !== null)
    ? evaluation.calls.reduce((n, c) => n + c.durationMs!, 0)
    : null;
  evaluation.recordingIncomplete ||= evaluation.calls.some(
    (c) => c.durationMs === null,
  );
  return evaluation;
}

/** Local UI reads have no model/task run. Keep them visible without allocating usage or quality. */
export function evaluateUiSkillReads(trace?: TraceReplay) {
  const ids = new Set(
    trace?.records
      .filter(
        (r) =>
          r.phase === "start" &&
          r.kind === "tool" &&
          ["ListProjectSkills", "LoadProjectSkill"].includes(r.label) &&
          ["list", "preview"].includes(String(object(r.input).uiAction)),
      )
      .map((r) => r.id),
  );
  if (!ids.size) return [];
  const root: TraceRecord = {
    id: "ui-skills",
    sequence: 0,
    phase: "start",
    kind: "task",
    agentId: "ui",
    label: "ui",
    at: "",
  };
  return (
    evaluateTrace({
      records: [
        root,
        ...trace!.records
          .filter((r) => ids.has(r.id))
          .map((r) => ({ ...r, taskId: root.id })),
        { ...root, phase: "end" },
      ],
      skipped: trace?.skipped ?? 0,
    })[0]?.skillReads ?? []
  );
}

export interface ComparisonEntry {
  task: TaskEvaluation;
  /** Identical case and acceptance conditions are required for a useful comparison. */
  caseId: string;
  taskType: string;
  difficulty: string;
  criteriaVersion: string;
  environment: string;
  configuration: string;
  assessment?: {
    source: "offline_test" | "explicit_evaluation";
    passed: boolean;
    evidence: string;
  };
}
export function compareEvaluations(entries: ComparisonEntry[]) {
  const groups = new Map<string, ComparisonEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([
      entry.caseId,
      entry.taskType,
      entry.difficulty,
      entry.criteriaVersion,
      entry.environment,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups].map(([key, runs]) => ({
    conditions: JSON.parse(key) as string[],
    runs: runs.map((run) => ({
      ...run,
      qualitySatisfied:
        run.task.outcome === "completed" &&
        run.assessment?.passed === true &&
        !!run.assessment.evidence,
      resourceComparable:
        !run.task.recordingIncomplete &&
        run.task.completeUsageCalls === run.task.calls.length &&
        run.task.calls.length > 0 &&
        run.task.simulatedCalls === 0 &&
        run.task.dispatchedCalls === run.task.calls.length,
    })),
  }));
}

const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function renderEvaluation(trace?: TraceReplay): string {
  const tasks = evaluateTrace(trace);
  const cards = tasks
    .map((task) => {
      const metrics = (["input", "output"] as const)
        .map(
          (key) =>
            `<tr><th>${key === "input" ? "In" : "Out"}</th><td>${task.metrics[key].known ?? "不明"}</td><td>${task.metrics[key].measuredCalls}/${task.calls.length}</td></tr>`,
        )
        .join("");
      const calls = task.calls
        .map(
          (c) =>
            `<tr><td><a href="#trace-${escape(c.spanId)}">${escape(c.agentId)}</a></td><td>${escape(c.provider)} / ${escape(c.model ?? "不明")} / ${escape(c.effort ?? "不明")}</td><td>${escape(c.status)}${c.simulated ? "（模擬）" : ""}</td><td>${c.durationMs ?? "不明"} ms</td></tr>`,
        )
        .join("");
      const skillReferences = task.skillReads?.length
        ? `<details><summary>スキルの参照記録（品質の証明ではない）</summary><pre>${escape(JSON.stringify(task.skillReads, null, 2))}</pre></details>`
        : "";
      return `<article><h3>タスク ${escape(task.taskId)}</h3><p>品質結果: ${task.outcome} (${escape(task.stopCause ?? "不明")}) · 所要時間: ${task.elapsedMs ?? "不明"} ms · 経過時間（再開待ち含む）: ${task.wallClockMs ?? "不明"} ms</p><p>レビュー試行 ${task.reviewAttempts} · 指摘に戻った修正ラウンド ${task.correctionRounds}${task.recordingIncomplete ? " · 記録欠落あり" : ""}</p><table><thead><tr><th>項目</th><th>取得済み合計</th><th>測定カバー率（呼出数）</th></tr></thead><tbody>${metrics}</tbody></table><details><summary>呼出と測定の詳細</summary><p>親実行 ${task.runs} 回 · 呼出試行: ${task.calls.length} (模擬 ${task.simulatedCalls} / 実fetch送信記録 ${task.dispatchedCalls}) · 完全なusage: ${task.completeUsageCalls}/${task.calls.length}</p><table><thead><tr><th>根拠</th><th>provider / model / effort</th><th>結果</th><th>通信時間</th></tr></thead><tbody>${calls}</tbody></table><pre>${escape(JSON.stringify(task.calls, null, 2))}</pre></details><details><summary>品質の根拠（モデルレビュー・コマンド実行・終了理由）</summary><pre>${escape(JSON.stringify(task.evidence, null, 2))}</pre></details>${skillReferences}</article>`;
    })
    .join("");
  const uiReads = evaluateUiSkillReads(trace);
  const uiCard = uiReads.length
    ? `<article><h3>UIのスキル確認（会話への読込・品質の証明ではない）</h3><pre>${escape(JSON.stringify(uiReads, null, 2))}</pre></article>`
    : "";
  const common = evaluateSessionCommon(trace);
  const unassigned = new Set(
    trace?.records
      .filter(
        (r) =>
          r.phase === "start" &&
          r.kind === "llm" &&
          !!r.taskId &&
          !tasks.some((t) => t.taskId === r.taskId),
      )
      .map((r) => r.attemptId ?? r.id) ?? [],
  ).size;
  const commonCard = common
    ? `<article><h3>セッション共通分</h3><p>対象タスクのない手動圧縮・旧記録。タスクの品質結果には含めません。呼出試行 ${common.calls.length} · 通信時間合計 ${common.elapsedMs ?? "不明"} ms</p><table><thead><tr><th>項目</th><th>取得済み合計</th><th>測定カバー率（呼出数）</th></tr></thead><tbody>${(["input", "output"] as const).map((key) => `<tr><th>${key === "input" ? "In" : "Out"}</th><td>${common.metrics[key].known ?? "不明"}</td><td>${common.metrics[key].measuredCalls}/${common.calls.length}</td></tr>`).join("")}</tbody></table><details><summary>共通分の根拠</summary><pre>${escape(JSON.stringify(common.calls, null, 2))}</pre></details></article>`
    : "";
  return `<section id="evaluation"><h2>品質・使用量の評価</h2><p>完了はハーネスの終了理由です。モデルの申告・レビューや任意コマンドの成功を、客観テスト合格とはみなしません。Inはcacheを含む総入力、Outはreasoningを含む総出力です。取得済み合計は部分値を含み、不明をゼロに置換しません。</p><p>未完了タスクのIDは再起動後も継承します。同じ試行IDの再配信は一度だけ数え、新しい再試行は別消費として集計します。境界欠落の通信 ${unassigned} 件はタスク合計に含めません。</p>${cards || "<p>評価タスク境界の記録がありません。旧レシート・トレースは下の詳細で確認できます。</p>"}${commonCard}${uiCard}</section>`;
}
