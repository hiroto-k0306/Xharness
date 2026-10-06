import { expect, it } from "vitest";
import { officialWorkflowReport } from "./report.js";
import type { WorkflowRecord } from "./runtime.js";
it("separates model evidence and escapes it without leaking diagnostic answer text", () => {
  const record: WorkflowRecord = {
    version: 1,
    simulated: true,
    id: "synthetic",
    goal: "test",
    cwd: "test",
    startedAt: "2026-10-06",
    status: "completed",
    next: "complete",
    base: "base",
    head: "head",
    correctionRounds: 0,
    tools: [],
    checks: [],
    reviews: [],
    commits: [],
    calls: [
      {
        requestId: "request",
        phase: "conversation",
        provider: "claude",
        requestedModel: "haiku",
        effort: null,
        status: "completed",
        dispatched: true,
        usage: null,
        observedModels: ["haiku", "sonnet"],
        elapsedMs: 1,
        diagnostics: {
          requestId: "request",
          requestedModel: "haiku",
          resolvedRequestedModel: "haiku",
          phase: "conversation",
          cwd: "test",
          sandbox: "read-only",
          approval: "plan",
          tools: [],
          sdkInitialModels: ["haiku"],
          assistants: [{ model: "sonnet", parentToolUseId: null }],
          resultModelUsage: [{ model: "sonnet", tokens: { inputTokens: 1 } }],
          finalAnswer: "never-show-diagnostic-body<script>",
        },
      },
    ],
  };
  const html = officialWorkflowReport(record);
  expect(html).toContain("主系列assistant（parent=null）: sonnet");
  expect(html).toContain("モデル不一致");
  expect(html).not.toContain("never-show");
  record.calls[0]!.requestedModel = "<script>";
  expect(officialWorkflowReport(record)).toContain("&lt;script&gt;");
});
