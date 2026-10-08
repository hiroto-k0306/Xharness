import { expect, it } from "vitest";
import type { WorkflowRecord } from "./runtime.js";
import { executionEvidence, measuredHead } from "./execution-evidence.js";
import { officialSessionSummary } from "./session-result.js";

function record(): WorkflowRecord {
  return {
    version: 1,
    simulated: true,
    id: "fixture",
    sessionId: "session",
    sourceCwd: "D:/project",
    cwd: "D:/fake-home/workspace-question-test",
    goal: "not included in facts",
    startedAt: new Date(0).toISOString(),
    status: "failed",
    next: "complete",
    base: "0".repeat(40),
    head: "0".repeat(40),
    correctionRounds: 0,
    calls: [],
    tools: [],
    checks: [],
    reviews: [],
    commits: [],
  };
}
it("does not interpret placeholder HEAD or isolated cwd as a missing Git project", () => {
  const r = record();
  expect(executionEvidence(r)).toMatchObject({
    sourceCwd: "D:/project",
    measuredHead: null,
  });
  expect(measuredHead("a".repeat(40))).toBe("a".repeat(40));
  const summary = officialSessionSummary(r, true);
  expect(summary).toContain("元の作業場所：D:/project");
  expect(summary).toContain("未測定");
  expect(summary).not.toContain("000000000000");
  delete r.sourceCwd;
  expect(executionEvidence(r).sourceCwd).toBeNull();
});
it("distinguishes confirmed communications from incomplete records and leaves public answers intact", () => {
  const r = record();
  const call = {
    requestId: "call",
    phase: "conversation" as const,
    provider: "claude" as const,
    requestedModel: "fixture",
    effort: null,
  };
  r.calls.push({ ...call, status: "running" });
  // A completed official result can contain much more data; only facts are selected.
  const completed = {
    ...call,
    status: "completed",
    dispatched: true,
    output: "PRIVATE_BODY",
    thinking: "PRIVATE_THINKING",
  };
  r.calls.push(completed as unknown as WorkflowRecord["calls"][number]);
  r.calls.push({
    ...completed,
    requestId: "call2",
  } as unknown as WorkflowRecord["calls"][number]);
  const facts = executionEvidence(r);
  expect(facts.confirmedDispatches).toBe(2);
  expect(facts.unmeasuredDispatches).toBe(1);
  expect(JSON.stringify(facts)).not.toContain("PRIVATE_");
  expect(officialSessionSummary(r, true)).toContain("通信確認済み：2回");
  r.answer = "exact public answer";
  expect(officialSessionSummary(r, false)).toBe(r.answer);
});
