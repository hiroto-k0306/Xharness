import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  evaluateTrace,
  evaluateSessionCommon,
  compareEvaluations,
  renderEvaluation,
  type ComparisonEntry,
} from "./evaluation.js";
import { renderComparison } from "./evaluation-comparison.js";
import { runReportDemo } from "./report-demo.js";
import { readTraceReplay } from "./report-trace.js";
import { renderExecutionReport, readExecutionReport } from "./report.js";
import { type TraceRecord } from "../core/trace.js";
import {
  captureTraceResponse,
  captureTraceUsage,
  traceStream,
  withSessionTrace,
  withTaskTrace,
} from "../core/trace.js";
import { type ProviderEvent } from "../providers/provider.js";
import { tokenMeasurement } from "../providers/token-usage.js";

const record = (
  id: string,
  kind: TraceRecord["kind"],
  phase: TraceRecord["phase"],
  extra: Partial<TraceRecord> = {},
): TraceRecord => ({
  id,
  kind,
  phase,
  agentId: "root",
  sequence: 1,
  label: kind,
  at: phase === "start" ? "2026-10-05T00:00:00Z" : "2026-10-05T00:00:01Z",
  ...extra,
});
it("deduplicates replayed attempts and roots while counting a genuine retry separately", () => {
  const root = record("root", "task", "start");
  const start = record("a", "llm", "start", {
    taskId: "root",
    attemptId: "attempt-a",
    label: "codex",
  });
  const end = record("a", "llm", "end", {
    taskId: "root",
    output: {
      usageComplete: true,
      tokenMeasurement: tokenMeasurement("codex", {
        input_tokens: 12,
        output_tokens: 4,
      }),
    },
  });
  const retry = { ...start, id: "b", attemptId: "attempt-b" };
  const records = [
    root,
    root,
    start,
    end,
    start,
    end,
    retry,
    { ...end, id: "b" },
    record("root", "task", "end", { output: { stopCause: "end_turn" } }),
  ];
  const task = evaluateTrace({ records, skipped: 0 })[0]!;
  expect(task.runs).toBe(1);
  expect(task.calls.map((c) => c.attemptId)).toEqual([
    "attempt-a",
    "attempt-b",
  ]);
  expect(task.metrics.input).toEqual({ known: 24, measuredCalls: 2 });
  expect(task.metrics.output.known).toBe(8);
  expect(evaluateTrace({ records, skipped: 0 })).toEqual(
    evaluateTrace({ records, skipped: 0 }),
  );
});
it("keeps common compaction and missing usage separate from completed tasks", () => {
  const records = [
    record("t", "task", "start"),
    record("t", "task", "end", { output: { stopCause: "end_turn" } }),
    record("common", "llm", "start"),
    record("common", "llm", "end", {
      output: {
        tokenMeasurement: tokenMeasurement("codex", { output_tokens: 7 }),
      },
    }),
  ];
  expect(evaluateTrace({ records, skipped: 0 })[0]!.calls).toHaveLength(0);
  expect(
    evaluateSessionCommon({ records: [...records, ...records], skipped: 0 }),
  ).toMatchObject({
    metrics: {
      input: { known: null, measuredCalls: 0 },
      output: { known: 7, measuredCalls: 1 },
    },
    completeUsageCalls: 0,
  });
  expect(renderEvaluation({ records, skipped: 0 })).toContain(
    "セッション共通分",
  );
  expect(renderEvaluation({ records, skipped: 0 })).not.toContain("API換算");
});
it("includes attributed manual compaction without changing task quality or counting its wait gap", () => {
  const records = [
    record("t", "task", "start"),
    record("t", "task", "end", { output: { stopCause: "aborted" } }),
    record("compact", "step", "start", {
      taskId: "t",
      label: "manual_compact",
      at: "2026-10-05T00:01:00Z",
    }),
    record("compact", "step", "end", {
      taskId: "t",
      label: "manual_compact",
      at: "2026-10-05T00:01:02Z",
    }),
    record("usage", "llm", "start", { taskId: "t" }),
  ];
  expect(evaluateTrace({ records, skipped: 0 })[0]).toMatchObject({
    outcome: "interrupted",
    elapsedMs: 3000,
    recordingIncomplete: true,
  });
  expect(evaluateSessionCommon({ records, skipped: 0 })).toBeUndefined();
});
it("aggregates parent and children, failed retry, and receipts only once through the real offline loop", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-evaluation-"));
  const { id } = await runReportDemo(home);
  const trace = await readTraceReplay(home, id, (s) => s);
  const tasks = evaluateTrace(trace);
  expect(tasks).toHaveLength(1);
  const task = tasks[0]!;
  expect(task.outcome).toBe("completed");
  expect(task.calls).toHaveLength(4);
  expect(task.calls.some((c) => c.status === "利用制限")).toBe(true);
  expect(new Set(task.calls.map((c) => c.agentId)).size).toBe(2);
  expect(task.simulatedCalls).toBe(4);
  expect(task.metrics.input).toEqual({ known: null, measuredCalls: 0 });
  expect(task.metrics.total).toEqual({ known: null, measuredCalls: 0 });
  expect(task.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(renderExecutionReport(await readExecutionReport(home, id))).toContain(
    "品質・使用量の評価",
  );
});
it("keeps partial failed usage, missing ends, review repair and command evidence separate", () => {
  const records = [
    record("t", "task", "start"),
    record("llm", "llm", "start", {
      taskId: "t",
      label: "codex",
      input: {
        internal: { model: "fixture-model", reasoning: { effort: "high" } },
      },
    }),
    record("llm", "llm", "end", {
      taskId: "t",
      status: "エラー",
      output: {
        tokenMeasurement: {
          provider: "codex",
          raw: { input_tokens: 20, output_tokens: 3 },
        },
      },
    }),
    record("r", "tool", "start", { taskId: "t", label: "RequestReview" }),
    record("r", "tool", "end", {
      taskId: "t",
      output: {
        content: JSON.stringify({
          phase: "implement",
          findings: [{ severity: "must" }],
        }),
      },
    }),
    record("b", "tool", "start", { taskId: "t", label: "Bash" }),
    record("t", "task", "end", { output: { stopCause: "aborted" } }),
  ];
  const task = evaluateTrace({ records, skipped: 0 })[0]!;
  expect(task.outcome).toBe("interrupted");
  expect(task.metrics.total.known).toBe(23);
  expect(task.completeUsageCalls).toBe(0);
  expect(task.reviewAttempts).toBe(1);
  expect(task.correctionRounds).toBe(1);
  expect(task.recordingIncomplete).toBe(true);
  expect(task.evidence.map((e) => e.source)).toEqual([
    "harness",
    "model_review",
    "command_execution",
  ]);
  expect(task.calls[0]?.effort).toBe("high");
  expect(renderEvaluation({ records, skipped: 0 })).toContain("不明");
});
it("does not fabricate task boundaries or quality from legacy records", () => {
  expect(evaluateTrace()).toEqual([]);
  expect(
    evaluateTrace({ records: [record("old", "llm", "start")], skipped: 0 }),
  ).toEqual([]);
  expect(renderEvaluation()).toContain("旧レシート");
});

it("groups continued workflow runs and distinguishes active time from resume gaps", () => {
  const records = [
    record("r1", "task", "start", { input: { taskId: "workflow" } }),
    record("r1", "task", "end", { output: { stopCause: "aborted" } }),
    record("r2", "task", "start", {
      at: "2026-10-05T00:00:10Z",
      input: { taskId: "workflow" },
    }),
    record("r2", "task", "end", {
      at: "2026-10-05T00:00:12Z",
      output: { stopCause: "workflow_complete", workflowPhase: "complete" },
    }),
  ];
  const task = evaluateTrace({ records, skipped: 0 })[0]!;
  expect(task).toMatchObject({
    taskId: "workflow",
    runs: 2,
    elapsedMs: 3000,
    wallClockMs: 12000,
    outcome: "completed",
  });
  records[3]!.output = { stopCause: "end_turn", workflowPhase: "implement" };
  expect(evaluateTrace({ records, skipped: 0 })[0]!.outcome).toBe(
    "interrupted",
  );
});
it("keeps numeric usage when oversized trace details are omitted", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-eval-large-"));
  await withSessionTrace(
    home,
    "large",
    (s) => s,
    () =>
      withTaskTrace({ model: "fixture" }, async () => {
        async function* events(): AsyncGenerator<ProviderEvent> {
          captureTraceUsage(
            tokenMeasurement("codex", { input_tokens: 100, output_tokens: 20 }),
          );
          captureTraceResponse({
            data: JSON.stringify({
              type: "response.completed",
              response: {
                usage: { input_tokens: 100, output_tokens: 20 },
                output: "a".repeat(900000),
              },
            }),
          });
          yield {
            type: "message_done",
            usage: { inputTokens: 100, outputTokens: 20 },
            stopReason: "end_turn",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "a".repeat(1100000) }],
            },
          };
        }
        for await (const event of traceStream(
          "codex",
          { internal: { model: "fixture" } },
          events(),
          true,
        ))
          void event;
        return { stopCause: "end_turn" };
      }),
  );
  const task = evaluateTrace(
    await readTraceReplay(home, "large", (s) => s),
  )[0]!;
  expect(task.metrics.total.known).toBe(120);
  expect(task.completeUsageCalls).toBe(1);
  expect(task.recordingIncomplete).toBe(true);
});
it("compares only identical conditions, requires explicit quality evidence, and excludes fake/partial usage from resource comparison", () => {
  const task = evaluateTrace({
    records: [
      record("t", "task", "start"),
      record("t", "task", "end", { output: { stopCause: "end_turn" } }),
    ],
    skipped: 0,
  })[0]!;
  const entry: ComparisonEntry = {
    task,
    caseId: "case-1",
    taskType: "edit",
    difficulty: "small",
    criteriaVersion: "v1",
    environment: "mock",
    configuration: "fixture",
  };
  const groups = compareEvaluations([
    entry,
    {
      ...entry,
      assessment: {
        source: "offline_test",
        passed: true,
        evidence: "assert contents",
      },
    },
    { ...entry, difficulty: "large" },
  ]);
  expect(groups).toHaveLength(2);
  expect(groups[0]?.runs.map((r) => r.qualitySatisfied)).toEqual([false, true]);
  expect(groups[0]?.runs.every((r) => !r.resourceComparable)).toBe(true);
  expect(
    renderComparison([{ ...entry, configuration: "<script>" }]),
  ).not.toContain("<script>");
});
