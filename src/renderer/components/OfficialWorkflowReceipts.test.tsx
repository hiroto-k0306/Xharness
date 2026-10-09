import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import { OfficialWorkflowReceipts } from "./OfficialWorkflowReceipts.js";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const record: WorkflowRecord = {
    version: 1,
    id: "w",
    sessionId: "chat",
    simulated: false,
    goal: "Saved scoped goal",
    cwd: "C:/chosen",
    startedAt: "2026-10-09T00:00:00Z",
    status: "interrupted",
    next: "implement",
    base: "a",
    head: "b",
    correctionRounds: 0,
    calls: [],
    tools: [],
    checks: [],
    commits: [],
    reviews: [
      {
        head: "b",
        base: "a",
        findings: [
          {
            severity: "must",
            file: "a.ts",
            line: 2,
            message: "Saved review finding",
            evidence: "Saved proof",
          },
        ],
      },
    ],
    nativeWork: { baseline: "files", validation: "agent-reported" },
    nativeValidation: [
      {
        command: "node --test selected.test.mjs",
        status: "failed",
        summary: "Saved verification failure",
      },
    ],
    plan: {
      summary: "Saved scoped plan",
      tasks: [
        {
          id: "t",
          title: "Task",
          instructions: "Saved instruction",
          files: ["a.ts"],
          acceptance: ["selected.test.mjs"],
          dependsOn: [],
          assignee: {
            provider: "codex",
            model: "saved-implementation-id",
            effort: "high",
            reason: "saved",
          },
        },
      ],
    },
  };
  const view: OfficialWorkflowView = {
    available: true,
    simulated: false,
    records: [
      {
        record,
        resumeBlocked: "native resume unsupported",
        reportHref: "saved-report.html",
      },
      {
        record: {
          ...record,
          id: "other",
          sessionId: "other",
          goal: "OTHER PRIVATE GOAL",
        },
        resumeBlocked: null,
        reportHref: "other.html",
      },
      {
        record: {
          ...record,
          id: "unknown",
          sessionId: undefined,
          goal: "UNKNOWN PRIVATE GOAL",
        },
        resumeBlocked: null,
        reportHref: "unknown.html",
      },
    ],
  };
  const api = vi.fn(async (command: OfficialWorkflowCommand) => {
    void command;
    return view;
  });
  vi.stubGlobal("harness", { officialWorkflow: api });
  return { record, view, api };
}
it("preserves saved results, review, assignments and report in conversation receipts without approvals", async () => {
  const { record } = fixture();
  const before = JSON.stringify(record);
  render(<OfficialWorkflowReceipts sessionId="chat" />);
  await screen.findByText("Saved scoped goal");
  expect(screen.getByText("Saved scoped plan")).toBeInTheDocument();
  expect(
    screen.getByRole("link", { name: "HTMLレポートを開く" }),
  ).toHaveAttribute("href", "saved-report.html");
  expect(screen.getByText(/node --test selected/)).toHaveTextContent("failed");
  expect(screen.getByText(/Saved review finding/)).toHaveTextContent(
    "Saved proof",
  );
  expect(screen.getByRole("region", { name: "t 実装担当" })).toHaveTextContent(
    "saved-implementation-id",
  );
  expect(
    screen.getByRole("button", { name: "安全な段階から再開" }),
  ).toBeDisabled();
  expect(screen.queryByText("OTHER PRIVATE GOAL")).not.toBeInTheDocument();
  expect(screen.queryByText("UNKNOWN PRIVATE GOAL")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "この計画を承認" }),
  ).not.toBeInTheDocument();
  expect(JSON.stringify(record)).toBe(before);
});
it("active workflow cancellation preserves saved conversation ID", async () => {
  const { view, api } = fixture();
  view.activeId = "w";
  render(<OfficialWorkflowReceipts sessionId="chat" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "workflowを中断" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({
      action: "cancel",
      id: "w",
      sessionId: "chat",
    }),
  );
});
it("conversation switch immediately hides previous receipts", async () => {
  fixture();
  const { rerender } = render(<OfficialWorkflowReceipts sessionId="chat" />);
  await screen.findByText("Saved scoped goal");
  rerender(<OfficialWorkflowReceipts sessionId="other" />);
  expect(screen.queryByText("Saved scoped goal")).not.toBeInTheDocument();
  await screen.findByText("OTHER PRIVATE GOAL");
});
it("preparation cancellation uses trusted conversation ownership", async () => {
  const { view, api } = fixture();
  view.records = [];
  view.activeId = "preparing";
  view.activeSessionId = "chat";
  const { rerender } = render(<OfficialWorkflowReceipts sessionId="other" />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(
    screen.queryByRole("button", { name: "接続確認を中断" }),
  ).not.toBeInTheDocument();
  rerender(<OfficialWorkflowReceipts sessionId="chat" />);
  fireEvent.click(
    await screen.findByRole("button", { name: "接続確認を中断" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith({
      action: "cancel",
      id: "preparing",
      sessionId: "chat",
    }),
  );
});
it("saved parallel decision and validation targets remain explicit in receipts", async () => {
  const { record } = fixture();
  record.plan!.parallelization = {
    mode: "parallel",
    maxParallel: 2,
    reason: "Independent files",
    conditions: ["No shared edits"],
    unresolved: [],
  };
  record.plan!.validation = { testFiles: ["a.test.mjs"] };
  render(<OfficialWorkflowReceipts sessionId="chat" />);
  await screen.findByText(/判断理由：Independent files/);
  expect(
    screen.getByRole("region", { name: "計画の実行方式と独立検証" }),
  ).toHaveTextContent("最大同時数：2");
  expect(
    screen.getByRole("region", { name: "計画の実行方式と独立検証" }),
  ).toHaveTextContent("a.test.mjs");
});

it("preserves independent native DAG checks and owned Git semantics without relabeling model reports", async () => {
  const { record } = fixture();
  record.nativeWork = { baseline: "files", validation: "independent-process" };
  record.nativeDagWorkspace = {
    source: "source",
    sourceBase: "a",
    sourceBranch: "main",
    approvalDigest: "a".repeat(64),
    ownedDirectory: "owned",
    tasks: [],
    integration: { cwd: "owned/integration", head: "b", status: "completed" },
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
  render(<OfficialWorkflowReceipts sessionId="chat" />);
  expect(
    await screen.findByText(/隔離Git worktreeのコミット/),
  ).toBeInTheDocument();
  expect(
    screen.getByText("独立プロセス検証・モデル報告・別会社レビュー"),
  ).toBeInTheDocument();
  expect(screen.getByText(/independent 合格/)).toHaveTextContent("process");
  expect(screen.getByText(/node --test selected/)).toHaveTextContent(
    "モデル報告",
  );
  expect(screen.queryByText(/自動commit・reset・mergeは行いません/)).toBeNull();
});
