import { expect, it } from "vitest";
import { officialWorkflowReport } from "./report.js";
import type { WorkflowRecord } from "./runtime.js";

function selectionRecord(
  call: WorkflowRecord["calls"][number],
): WorkflowRecord {
  return {
    version: 1,
    simulated: true,
    id: "selection",
    goal: "fixture",
    cwd: "fixture",
    startedAt: "2026-10-09",
    status: "implementing",
    next: "implement",
    base: "a",
    head: "b",
    correctionRounds: 0,
    tools: [],
    checks: [],
    reviews: [],
    commits: [],
    calls: [call],
  };
}
const selectionCall: WorkflowRecord["calls"][number] = {
  requestId: "selection-call",
  provider: "codex",
  phase: "implement",
  requestedModel: "gpt-call-id",
  effort: "high",
  status: "running",
};
it("exports escaped skill dispatch and observed use as different evidence", () => {
  const record = selectionRecord({
    ...selectionCall,
    provider: "claude",
    officialSkills: {
      requested: [
        {
          provider: "claude",
          scope: "project",
          name: "<guide>",
          source: "<source>",
          hash: "a".repeat(64),
          bundleHash: "b".repeat(64),
        },
      ],
      dispatched: [{ name: "<guide>", mechanism: "claude-plugin" }],
    },
  });
  const before = JSON.stringify(record),
    html = officialWorkflowReport(record);
  expect(html).toContain("&lt;guide&gt; · claude-plugin");
  expect(html).toContain("&lt;source&gt;");
  expect(html).toContain("使用は未確認");
  expect(html).not.toContain("<guide>");
  expect(JSON.stringify(record)).toBe(before);
  record.calls[0]!.officialSkills!.observed = [
    { name: "<guide>", status: "completed" },
  ];
  expect(officialWorkflowReport(record)).toContain("&lt;guide&gt; · 呼出完了");
  expect(officialWorkflowReport(record)).toContain(
    "タスク全体の成功を証明しません",
  );
});
it("exports escaped saved alias resolutions and changes without rewriting history", () => {
  const record = selectionRecord({
    ...selectionCall,
    modelSelection: {
      policy: { provider: "codex", model: "<sol>", effort: "high" },
      resolved: {
        provider: "codex",
        model: "<gpt-call-id>",
        effort: "high",
        catalog: {
          version: 2,
          updatedAt: '<img src="x">',
          digest: "b".repeat(64),
        },
      },
      previous: {
        model: "<gpt-previous>",
        effort: "low",
        catalog: {
          version: 1,
          updatedAt: "previous-date",
          digest: "a".repeat(64),
        },
      },
      changed: true,
    },
  });
  const before = JSON.stringify(record),
    html = officialWorkflowReport(record);
  expect(html).toContain("保存policy：codex:&lt;sol&gt; / effort：high");
  expect(html).toContain(
    "呼出時の実ID：codex/&lt;gpt-call-id&gt; / effort：high",
  );
  expect(html).toContain(
    "catalog：v2 · &lt;img src=&quot;x&quot;&gt; · digest " + "b".repeat(64),
  );
  expect(html).toContain(
    "前回の実ID：&lt;gpt-previous&gt; / effort：low / catalog：v1",
  );
  expect(html).toContain("前回との変更：あり");
  expect(html).not.toContain('<img src="x">');
  expect(JSON.stringify(record)).toBe(before);
});
it("exports historical IDs with missing policy evidence instead of inventing an alias", () => {
  const html = officialWorkflowReport(selectionRecord(selectionCall));
  expect(html).toContain(
    "当時の指定ID：codex/gpt-call-id / effort：high（alias policy・catalogの保存記録なし）",
  );
  expect(html).not.toContain("保存policy：");
});
it("does not claim unchanged resolution when the previous call evidence is absent", () => {
  const html = officialWorkflowReport(
    selectionRecord({
      ...selectionCall,
      modelSelection: {
        policy: { provider: "codex", model: "sol", effort: "high" },
        resolved: {
          provider: "codex",
          model: "gpt-call-id",
          effort: "high",
          catalog: { version: 1, updatedAt: "date", digest: "a".repeat(64) },
        },
        changed: false,
      },
    }),
  );
  expect(html).toContain("前回との変更：前回の解決記録なし");
});
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
  record.calls[0]!.communication.events = [
    {
      actor: "llm",
      kind: "response",
      sequence: 1,
      body: { text: "<script>public</script>", truncated: true },
    },
  ];
  record.calls[0]!.communication.eventsOmitted = true;
  const eventsHtml = officialWorkflowReport(record);
  expect(eventsHtml).toContain("公開イベントの時系列");
  expect(eventsHtml).toContain("LLM — 応答");
  expect(eventsHtml).toContain("&lt;script&gt;public&lt;/script&gt;");
  expect(eventsHtml).not.toContain("<script>");
  expect(eventsHtml).toContain("一部のイベントを省略");
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

it("separates native DAG Git commits, independent processes and model reports", () => {
  const record = selectionRecord(selectionCall);
  record.nativeWork = { baseline: "files", validation: "independent-process" };
  record.nativeDagWorkspace = {
    source: "<source>",
    sourceBase: "a",
    sourceBranch: "main",
    approvalDigest: "a".repeat(64),
    ownedDirectory: "owned",
    tasks: [],
    integration: { cwd: "owned/integration", head: "b", status: "completed" },
  };
  record.dag = {
    maxParallel: 2,
    phase: "complete",
    nodes: [],
    nativeConversationResume: false,
  };
  record.checks = [
    {
      head: "b",
      tests: [
        {
          id: "independent",
          passed: true,
          exitCode: 0,
          elapsedMs: 1,
          source: "process",
          output: "fixture",
        },
      ],
    },
  ];
  record.nativeValidation = [
    { command: "agent-only", status: "failed", summary: "model report" },
  ];
  const html = officialWorkflowReport(record);
  expect(html).toContain("base/headは所有する隔離Git worktreeのGitコミット");
  expect(html).toContain("独立プロセスの結果はchecks表");
  expect(html).toContain("agent-only: failed");
  expect(html).toContain("process");
  expect(html).not.toContain("固定合成課題の模擬実行");
  record.nativeDagWorkspace.integration = undefined;
  expect(officialWorkflowReport(record)).toContain(
    "base/headはファイル比較digest",
  );
});
