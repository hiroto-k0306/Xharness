import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
import { ChatOfficialApprovals } from "./ChatOfficialApprovals.js";
import { Transcript } from "./Transcript.js";
afterEach(() => vi.unstubAllGlobals());
const record: WorkflowRecord = {
  version: 1,
  id: "workflow",
  sessionId: "chat",
  simulated: true,
  goal: "Change requested",
  cwd: "C:/project",
  startedAt: "2026-10-09T00:00:00Z",
  status: "approval",
  next: "approval",
  base: "a",
  head: "a",
  correctionRounds: 0,
  calls: [],
  tools: [],
  checks: [],
  reviews: [],
  commits: [],
  nativeWork: { baseline: "files", validation: "agent-reported" },
  plan: {
    summary: "Safe plan",
    tasks: [
      {
        id: "t",
        title: "Implement",
        instructions: "Edit one file",
        files: ["src/a.ts"],
        acceptance: ["node --test"],
        dependsOn: [],
        assignee: {
          provider: "codex",
          model: "gpt-6.1-sol",
          effort: "high",
          reason: "saved",
        },
        reviewer: {
          provider: "claude",
          model: "claude-opus-5-5",
          effort: "medium",
          reason: "review",
        },
      },
    ],
  },
};
function fixture(patch: Partial<OfficialWorkflowView> = {}) {
  const view: OfficialWorkflowView = {
    available: true,
    simulated: true,
    approval: {
      id: "workflow",
      approvalId: "grant",
      sessionId: "chat",
      digest: "digest",
      expiresAt: Date.now() + 60000,
    },
    records: [
      {
        record: structuredClone(record),
        resumeBlocked: null,
        reportHref: "report",
      },
    ],
    ...patch,
  };
  const api = vi.fn(async (command: OfficialWorkflowCommand) => {
    void command;
    return view;
  });
  vi.stubGlobal("harness", { officialWorkflow: api });
  return { view, api };
}
it.each([true, false])(
  "shows bound plan in transcript and sends one decision (%s)",
  async (allow) => {
    const { api } = fixture();
    render(
      <Transcript items={[]} running={false} model="codex:sol">
        <ChatOfficialApprovals sessionId="chat" />
      </Transcript>,
    );
    const card = await screen.findByRole("alertdialog", {
      name: "この会話の計画承認",
    });
    expect(screen.getByTestId("transcript")).toContainElement(card);
    expect(card).toHaveTextContent("src/a.ts");
    expect(card).toHaveTextContent("gpt-6.1-sol");
    expect(card).toHaveTextContent("high");
    expect(card).toHaveTextContent("claude-opus-5-5");
    expect(card).toHaveTextContent("digest");
    expect(card).toHaveTextContent("期限");
    const button = screen.getByRole("button", {
      name: allow ? "この計画を承認" : "計画を拒否",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.mock.calls.filter(([c]) => c.action === "approve")).toEqual([
        [
          {
            action: "approve",
            id: "workflow",
            approvalId: "grant",
            digest: "digest",
            sessionId: "chat",
            allow,
          },
        ],
      ]),
    );
    expect(button).toBeDisabled();
  },
);
it.each([undefined, "other"])(
  "never maps absent or different saved session by cwd (%s)",
  async (sessionId) => {
    const { view, api } = fixture();
    view.records[0]!.record.sessionId = sessionId;
    render(<ChatOfficialApprovals sessionId="chat" />);
    await waitFor(() => expect(api).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  },
);
it("expired plan disables allow and deny", async () => {
  const { view, api } = fixture();
  view.approval!.expiresAt = Date.now() - 1;
  render(<ChatOfficialApprovals sessionId="chat" />);
  const button = await screen.findByRole("button", { name: "この計画を承認" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(api.mock.calls.some(([c]) => c.action === "approve")).toBe(false);
});
it("switching conversations immediately removes prior grants", async () => {
  fixture();
  const { rerender } = render(<ChatOfficialApprovals sessionId="chat" />);
  await screen.findByRole("alertdialog");
  rerender(<ChatOfficialApprovals sessionId="other" />);
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});
it("native thread ID alone cannot identify a conversation", async () => {
  const { view, api } = fixture({ approval: undefined });
  view.operationApproval = {
    workflowId: "workflow",
    approvalId: "op",
    digest: "operation",
    sessionId: "chat",
    requestId: "req",
    turnId: "turn",
    itemId: "item",
    command: "node --test",
    cwd: record.cwd,
    targets: ["src/a.ts"],
    reason: "validate",
    expiresAt: Date.now() + 60000,
  };
  render(<ChatOfficialApprovals sessionId="chat" />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
});

it("notification focus identifies the bound card and never grants", async () => {
  const { api } = fixture();
  render(
    <ChatOfficialApprovals
      sessionId="chat"
      focus={{ workflowId: "workflow", approvalId: "grant", sequence: 1 }}
    />,
  );
  const card = await screen.findByRole("alertdialog");
  await waitFor(() => expect(card).toHaveFocus());
  expect(api.mock.calls.every(([command]) => command.action === "list")).toBe(
    true,
  );
});
