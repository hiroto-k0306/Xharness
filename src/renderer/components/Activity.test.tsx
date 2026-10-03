import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { UsagePopover, Receipts, LoopFlow } from "./Activity.js";
import { WorkspacePicker } from "./WorkspacePicker.js";
import { type HarnessApi } from "../../shared/ipc.js";
it("shows per-turn/session budgets and labels simulated calls independently from quota", () => {
  render(
    <UsagePopover
      open
      onClose={() => {}}
      onToggle={() => {}}
      usage={{}}
      calls={{
        turn: 2,
        session: 5,
        simulatedTurn: 1,
        simulatedSession: 3,
        llmCallsPerTurn: 4,
        llmCallsPerSession: 0,
        since: 0,
      }}
    />,
  );
  expect(screen.getByText("今ターン: 2 / 4")).toBeInTheDocument();
  expect(screen.getByText("セッション: 5 / 無制限")).toBeInTheDocument();
  expect(
    screen.getByText("うち模擬: 今ターン 1 / セッション 3"),
  ).toBeInTheDocument();
  expect(screen.getAllByText("取得不可").length).toBeGreaterThan(0);
});
it("shows unknown quota separately from 0%, displays reset/fallback, and emits one threshold toast", () => {
  const props = {
    open: true,
    onClose: vi.fn(),
    onToggle: vi.fn(),
    fallback: { claude: "codex:sol" },
    usage: {
      claude: {
        type: "usage" as const,
        provider: "claude" as const,
        window5h: 0,
        weekly: 96,
        windows: [
          {
            name: "7d",
            usedPercent: 96,
            windowMinutes: 10080,
            resetAt: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
      },
    },
  };
  const view = render(<UsagePopover {...props} />);
  expect(screen.getByText("◔ usage 96% ▾")).toBeInTheDocument();
  expect(screen.getByText("0%")).toBeInTheDocument();
  expect(screen.getAllByText("取得不可").length).toBeGreaterThan(0);
  expect(screen.getByText("fallback: codex:sol")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("claude 7d: 96%");
  fireEvent.click(within(screen.getByRole("status")).getByRole("button"));
  view.rerender(<UsagePopover {...props} usage={{ ...props.usage }} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(props.onClose).toHaveBeenCalled();
});
it("shows receipt details as plain text and loop gate as waiting", () => {
  render(
    <>
      <Receipts
        receipts={[
          {
            id: "#001",
            sessionId: "test",
            ts: 1,
            provider: "harness",
            kind: "tool",
            tool: "Read",
            durationMs: 2,
            summary: "Read",
            input: { path: "file" },
            output: "<script>untrusted()</script>\ncode",
          },
        ]}
      />
      <LoopFlow
        model="gpt-6-luna"
        view={{
          items: [],
          running: true,
          step: { step: 4, node: "gate", round: 2 },
          pending: { requestId: "a", tool: "Read", summary: "Read" },
        }}
      />
    </>,
  );
  fireEvent.click(screen.getByText("#001"));
  expect(screen.getByRole("dialog")).toHaveTextContent("untrusted()");
  expect(screen.getByRole("dialog").querySelector("script")).toBeNull();
  expect(
    screen.getByText("# approval required").closest("div[class]")?.className,
  ).toContain("waiting");
});
it("submits repository options and worktree branch choices through the validated command API", async () => {
  const command = vi
    .fn<HarnessApi["command"]>()
    .mockResolvedValue({ ok: true, workspaceId: "repo" });
  window.harness = { command, onEvent: () => () => {} };
  const start = vi.fn();
  render(
    <WorkspacePicker
      workspaces={[
        {
          id: "repo",
          name: "repository",
          root: "C:/repo",
          kind: "git",
          lastOpenedAt: 1,
        },
      ]}
      currentId="repo"
      onPickFolder={async () => undefined}
      onStart={start}
      onForget={() => {}}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "repository" }));
  fireEvent.change(screen.getByLabelText("repository URL"), {
    target: { value: "https://example.com/a/b.git" },
  });
  fireEvent.click(screen.getByRole("button", { name: "clone / fetch" }));
  expect(command).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "open_repository",
      url: "https://example.com/a/b.git",
    }),
  );
  fireEvent.click(screen.getByRole("tab", { name: "folder" }));
  fireEvent.click(screen.getByLabelText(/worktree で隔離する/));
  fireEvent.change(screen.getByLabelText("new worktree branch"), {
    target: { value: "feature/test" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "start session in repository" }),
  );
  expect(start).toHaveBeenCalledWith(
    "repo",
    false,
    true,
    undefined,
    "feature/test",
  );
});
