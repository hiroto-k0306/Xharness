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
  record.calls[0]!.communication = {
    boundary: "xharness-official-agent",
    input: { text: "<script>request</script>", truncated: true },
    output: { text: "structured response", truncated: false },
  };
  const detail = officialWorkflowReport(record);
  expect(detail).toContain("LLMの入力と応答");
  expect(detail).toContain("&lt;script&gt;request&lt;/script&gt;");
  expect(detail).not.toContain("<script>");
  expect(detail).toContain("structured response");
  expect(detail).toContain("保存上限");
  const call = record.calls[0]!;
  if (!("diagnostics" in call) || !call.diagnostics) throw new Error("fixture");
  call.diagnostics.approvals = [
    {
      method: "item/commandExecution/requestApproval",
      decision: "denied",
      source: "plan",
      stage: "program",
      reason: "shell-wrapper",
      command: "pwsh -Command <script>",
    },
  ];
  call.diagnostics.commandRuns = [
    {
      itemId: "exec-1",
      status: "failed",
      exitCode: 1,
      durationMs: null,
      source: "agent",
      cwd: "same",
      argv: "not-provided",
      output: "<b>error</b>",
      outputSource: "aggregated",
      outputTruncated: false,
    },
  ];
  const denied = officialWorkflowReport(record);
  expect(denied).toContain(
    "<td>exec-1</td><td>failed</td><td>1</td><td>未報告</td>",
  );
  expect(denied).toContain("&lt;b&gt;error&lt;/b&gt;");
  expect(denied).toContain("<td>拒否</td>");
  expect(denied).toContain("<td>program</td><td>shell-wrapper</td>");
  expect(denied).toContain("pwsh -Command &lt;script&gt;");
  record.calls[0]!.requestedModel = "<script>";
  expect(officialWorkflowReport(record)).toContain("&lt;script&gt;");
});
