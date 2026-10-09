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

it("distinguishes native DAG owned Git integration HEAD from source base and pre-integration digests", () => {
  const r = record();
  r.nativeWork = { validation: "agent-reported", baseline: "files" };
  r.base = "c".repeat(64);
  r.head = "d".repeat(64);
  r.nativeDagWorkspace = {
    source: "D:/source",
    sourceBase: "a".repeat(40),
    sourceBranch: "main",
    approvalDigest: "e".repeat(64),
    ownedDirectory: "D:/owned",
    tasks: [],
  };
  const before = JSON.stringify(r);
  expect(executionEvidence(r)).toMatchObject({
    measuredHead: null,
    sourceCwd: "D:/source",
    sourceBaseHead: "a".repeat(40),
    ownedIntegrationHead: null,
  });
  expect(officialSessionSummary(r, true)).toContain(
    `ファイル比較digest ${r.head}`,
  );
  expect(officialSessionSummary(r, true)).toContain(
    "元リポジトリのsource base",
  );
  expect(JSON.stringify(r)).toBe(before);
  r.nativeDagWorkspace.integration = {
    cwd: "D:/owned/integration",
    head: "b".repeat(40),
    status: "completed",
  };
  r.base = "a".repeat(40);
  r.head = "b".repeat(40);
  r.cwd = "D:/owned/integration";
  r.nativeWork.validation = "independent-process";
  expect(executionEvidence(r)).toMatchObject({
    measuredHead: "b".repeat(40),
    sourceBaseHead: "a".repeat(40),
    ownedIntegrationHead: "b".repeat(40),
  });
  const summary = officialSessionSummary(r, true);
  expect(summary).toContain(`統合HEAD ${r.head}`);
  expect(summary).toContain(`source base ${r.base}`);
  expect(summary).toContain("利用者ブランチ未変更");
  expect(summary).not.toContain("ファイル比較digest");
  r.answer = "saved public answer";
  expect(officialSessionSummary(r, true)).toBe("saved public answer");
});
