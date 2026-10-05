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
  const starts = trace.records.filter((r) => r.phase === "start");
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
            input: valid(usage.inputTokens),
            output: valid(usage.outputTokens),
          };
        }
        const request = object(object(start.input).internal);
        return {
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
    let reviewAttempts = 0;
    let correctionRounds = 0;
    for (const start of records) {
      const end = ends.get(start.id);
      const output = object(end?.output);
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
      elapsedMs: runs.every((r) => duration(r, ends.get(r.id)) !== null)
        ? runs.reduce((n, r) => n + duration(r, ends.get(r.id))!, 0)
        : null,
      wallClockMs: duration(root, end),
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
      const metrics = keys
        .map(
          (key) =>
            `<tr><th>${key}</th><td>${task.metrics[key].known ?? "不明"}</td><td>${task.metrics[key].measuredCalls}/${task.calls.length}</td></tr>`,
        )
        .join("");
      const calls = task.calls
        .map(
          (c) =>
            `<tr><td><a href="#trace-${escape(c.spanId)}">${escape(c.agentId)}</a></td><td>${escape(c.provider)} / ${escape(c.model ?? "不明")} / ${escape(c.effort ?? "不明")}</td><td>${escape(c.status)}${c.simulated ? "（模擬）" : ""}</td><td>${c.durationMs ?? "不明"} ms</td></tr>`,
        )
        .join("");
      return `<article><h3>タスク ${escape(task.taskId)}</h3><p>終了: ${task.outcome} (${escape(task.stopCause ?? "不明")}) · 稼働時間: ${task.elapsedMs ?? "不明"} ms · 経過時間（再開待ち含む）: ${task.wallClockMs ?? "不明"} ms · 親実行 ${task.runs} 回 · 呼出試行: ${task.calls.length} (模擬 ${task.simulatedCalls} / 実fetch送信記録 ${task.dispatchedCalls}) · 完全なusage: ${task.completeUsageCalls}/${task.calls.length}</p><p>レビュー試行 ${task.reviewAttempts} · 指摘に戻った修正ラウンド ${task.correctionRounds}${task.recordingIncomplete ? " · 記録欠落あり" : ""}</p><table><thead><tr><th>項目</th><th>取得済み合計</th><th>測定カバー率（呼出数）</th></tr></thead><tbody>${metrics}</tbody></table><table><thead><tr><th>根拠</th><th>provider / model / effort</th><th>結果</th><th>通信時間</th></tr></thead><tbody>${calls}</tbody></table><details><summary>品質の根拠（モデルレビュー・コマンド実行・終了理由）</summary><pre>${escape(JSON.stringify(task.evidence, null, 2))}</pre></details></article>`;
    })
    .join("");
  const unassigned =
    trace?.records.filter(
      (r) =>
        r.phase === "start" &&
        r.kind === "llm" &&
        !tasks.some((t) => t.taskId === r.taskId),
    ).length ?? 0;
  return `<section id="evaluation"><h2>品質・使用量の評価</h2><p>完了はハーネスの終了理由です。モデルの申告・レビューや任意コマンドの成功を、客観テスト合格とはみなしません。取得済み合計は部分値を含み、不明をゼロに置換しません。OpenAI cache/reasoningは内数、Anthropic cacheは別建てです。サブスク枠消費とAPI換算費用は未測定です。</p><p>同じ起動中のワークフローの継続・修正を同一タスクに集計します。通常会話は親の実行1回です。アプリ再起動後や新規ワークフローは別タスクになります。未関連通信 ${unassigned} 件（手動圧縮・旧記録など）は合計に含めません。</p>${cards || "<p>評価タスク境界の記録がありません。旧レシート・トレースは下の詳細で確認できます。</p>"}</section>`;
}
