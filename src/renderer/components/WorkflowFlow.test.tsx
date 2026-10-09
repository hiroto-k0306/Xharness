import {
  act,
  render,
  screen,
  within,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
import type { OfficialWorkflowView } from "../../shared/official-workflow.js";
import { WorkflowFlow } from "./WorkflowFlow.js";

function record(patch: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    version: 1,
    simulated: true,
    id: "w",
    sessionId: "s",
    goal: "test",
    cwd: "fixture",
    startedAt: "2026-10-08T00:00:00Z",
    status: "verifying",
    next: "verify",
    base: "a",
    head: "b",
    correctionRounds: 0,
    calls: [],
    tools: [],
    checks: [],
    reviews: [],
    commits: [],
    ...patch,
  };
}
function snapshot(r: WorkflowRecord): OfficialWorkflowView {
  return {
    available: true,
    simulated: true,
    records: [{ record: r, resumeBlocked: null, reportHref: "fixture" }],
  };
}
function setup(result: OfficialWorkflowView) {
  const read = vi.fn(async () => result);
  window.harness = {
    command: vi.fn(),
    onEvent: () => () => {},
    officialWorkflow: read,
  };
  return read;
}
const props = {
  sessionId: "s",
  running: false,
  scopeRequired: false,
  enabled: true,
};
it("labels native validation as model-reported without claiming an independent process", async () => {
  setup(
    snapshot(
      record({
        status: "completed",
        next: "complete",
        nativeWork: { validation: "agent-reported", baseline: "files" },
        nativeValidation: [
          { command: "pnpm test", status: "passed", summary: "agent report" },
        ],
      }),
    ),
  );
  render(<WorkflowFlow {...props} />);
  expect(await screen.findByText("モデルのテスト実行報告")).toBeInTheDocument();
  expect(screen.queryByText("ハーネスがローカルプロセスを実行")).toBeNull();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("uses saved test state and separates host tests from native tools", async () => {
  setup(
    snapshot(
      record({
        tools: [
          {
            requestId: "req",
            actionId: "a",
            inputDigest: "h",
            name: "Edit",
            status: "completed",
            source: "plan",
          },
        ],
      }),
    ),
  );
  render(<WorkflowFlow {...props} running />);
  expect(await screen.findByText("テスト工程中")).toBeInTheDocument();
  expect(screen.getByText("Edit · 実行完了")).toBeInTheDocument();
  expect(
    screen.getByText("ハーネスがローカルプロセスを実行"),
  ).toBeInTheDocument();
  expect(screen.getByText("独立テスト").parentElement).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(screen.queryByText(/owner:/)).toBeNull();
});
it("questions do not mark unexecuted work stages as completed", async () => {
  setup(
    snapshot(
      record({
        status: "completed",
        next: "complete",
        inputIntent: "question",
        finishedAt: "now",
        calls: [
          {
            requestId: "q",
            phase: "conversation",
            provider: "claude",
            requestedModel: "haiku",
            effort: "low",
            status: "completed",
            dispatched: true,
            observedModels: [],
            usage: null,
            elapsedMs: 1,
          },
        ],
      }),
    ),
  );
  render(<WorkflowFlow {...props} />);
  expect(await screen.findByText("要求先: Claude · haiku")).toBeInTheDocument();
  expect(
    within(screen.getByText("計画").parentElement!).getByText("未記録"),
  ).toBeInTheDocument();
  expect(screen.getByText("独立テスト").parentElement).not.toHaveAttribute(
    "aria-current",
  );
});
it("shows scope waiting after work classification without claiming planning", async () => {
  setup(
    snapshot(
      record({ status: "completed", next: "complete", inputIntent: "work" }),
    ),
  );
  render(<WorkflowFlow {...props} scopeRequired />);
  await screen.findByText("対象の確認待ち");
  expect(
    screen.getByText("対象ファイル・既存テストの確認").parentElement,
  ).toHaveAttribute("aria-current", "step");
});
it("shows requested fix model and individual approval waiting", async () => {
  const value = snapshot(
    record({
      status: "implementing",
      next: "fix",
      correctionRounds: 1,
      calls: [
        {
          requestId: "fix",
          phase: "fix",
          provider: "codex",
          requestedModel: "luna",
          effort: "low",
          status: "running",
        },
      ],
    }),
  );
  value.operationApproval = {
    workflowId: "w",
    requestId: "fix",
    sessionId: "native",
    turnId: "t",
    itemId: "i",
    command: "read",
    cwd: "fixture",
    targets: ["file"],
    reason: "test",
    approvalId: "a",
    digest: "d",
    expiresAt: Date.now() + 1000,
  };
  setup(value);
  render(<WorkflowFlow {...props} running />);
  expect(await screen.findByText("今回の操作の承認待ち")).toBeInTheDocument();
  expect(screen.getByText("要求先: Codex · luna")).toBeInTheDocument();
});
it("does not display another session's result or an old completed run during preparation", async () => {
  setup(
    snapshot(
      record({ sessionId: "other", status: "completed", finishedAt: "now" }),
    ),
  );
  const ui = render(<WorkflowFlow {...props} running />);
  await act(async () => {});
  expect(screen.getByRole("status")).toHaveTextContent("実行準備中");
  setup(snapshot(record({ status: "completed", finishedAt: "now" })));
  ui.rerender(<WorkflowFlow key="new" {...props} running />);
  await act(async () => {});
  expect(screen.getByRole("status")).toHaveTextContent("実行準備中");
});
it("does not overlap reads or accept a delayed response from the previous session", async () => {
  vi.useFakeTimers();
  let resolveOld!: (v: OfficialWorkflowView) => void;
  const read = setup(
    snapshot(record({ sessionId: "b", status: "failed", error: "stopped" })),
  );
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const ui = render(<WorkflowFlow {...props} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(read).toHaveBeenCalledTimes(1);
  ui.rerender(<WorkflowFlow key="b" {...props} sessionId="b" />);
  await act(async () => {});
  expect(screen.getByText("停止理由: stopped")).toBeInTheDocument();
  await act(async () => {
    resolveOld(snapshot(record({ error: "old" })));
  });
  expect(screen.queryByText("停止理由: old")).toBeNull();
  ui.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(read).toHaveBeenCalledTimes(2);
});
it("does not fetch when closed, and treats retrieval failure as unknown", async () => {
  const read = setup(snapshot(record()));
  const ui = render(<WorkflowFlow {...props} enabled={false} />);
  expect(read).not.toHaveBeenCalled();
  read.mockRejectedValueOnce(new Error("unavailable"));
  ui.rerender(<WorkflowFlow {...props} />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "状態を取得できません",
    ),
  );
  expect(screen.getAllByText("状態不明")).toHaveLength(7);
});

it("shows native DAG independent checks separately from agent reports", async () => {
  setup(
    snapshot(
      record({
        status: "completed",
        next: "complete",
        nativeWork: { validation: "independent-process", baseline: "files" },
        nativeDagWorkspace: {
          source: "source",
          sourceBase: "a",
          sourceBranch: "main",
          approvalDigest: "a".repeat(64),
          ownedDirectory: "owned",
          tasks: [],
          integration: {
            cwd: "owned/integration",
            head: "b",
            status: "completed",
          },
        },
        checks: [
          {
            head: "b",
            tests: [
              {
                id: "independent",
                exitCode: 0,
                passed: true,
                elapsedMs: 1,
                source: "process",
                output: "fixture",
              },
            ],
          },
        ],
        nativeValidation: [
          { command: "agent-only", status: "failed", summary: "agent report" },
        ],
      }),
    ),
  );
  render(<WorkflowFlow {...props} />);
  expect(await screen.findByText("独立テスト")).toBeInTheDocument();
  expect(
    screen.getByText("ハーネスがローカルプロセスを実行"),
  ).toBeInTheDocument();
  expect(screen.getByText("1/1件 合格")).toBeInTheDocument();
  expect(screen.queryByText("モデルのテスト実行報告")).toBeNull();
});
