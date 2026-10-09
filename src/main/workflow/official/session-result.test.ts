import { expect, it } from "vitest";
import type { WorkflowRecord } from "./runtime.js";
import { officialSessionSummary } from "./session-result.js";
import { officialWorkflowReport } from "./report.js";

it.each(["error_max_turns", "unknown"])(
  "explains only evidenced legacy SDK stops without rewriting history: %s",
  (termination) => {
    const record: WorkflowRecord = {
      version: 1,
      id: "synthetic",
      sessionId: "s",
      cwd: "synthetic",
      sourceCwd: "synthetic",
      goal: "synthetic",
      simulated: true,
      startedAt: "2026-10-09T00:00:00Z",
      status: "failed",
      next: "complete",
      base: "a".repeat(64),
      head: "a".repeat(64),
      correctionRounds: 0,
      error: "failed",
      tools: [],
      checks: [],
      reviews: [],
      commits: [],
      calls: [
        {
          requestId: "fixture",
          phase: "plan",
          provider: "claude",
          requestedModel: "fixture-opus",
          effort: null,
          status: "failed",
          dispatched: true,
          elapsedMs: 1,
          observedModels: [],
          usage: null,
          diagnostics: {
            requestId: "fixture",
            requestedModel: "fixture-opus",
            phase: "plan",
            cwd: "synthetic",
            sandbox: "read-only",
            approval: "plan",
            tools: [],
            sdkInitialModels: [],
            assistants: [],
            resultModelUsage: [],
            termination,
          },
        },
      ],
    };
    const before = JSON.stringify(record);
    for (const text of [
      officialSessionSummary(record, true),
      officialWorkflowReport(record),
    ])
      expect(text.includes("内部往復回数の上限")).toBe(
        termination === "error_max_turns",
      );
    expect(JSON.stringify(record)).toBe(before);
  },
);
