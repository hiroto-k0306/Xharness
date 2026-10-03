import { render, screen, fireEvent, within } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import { AgentsPanel } from "./components/AgentsPanel.js";
import { PhaseBar } from "./components/PhaseBar.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { PlanApproval } from "./components/PlanApproval.js";
import { applyEvent, type EventState } from "./state/store.js";
import { useStore } from "./state/store.js";
import { App } from "./App.js";
const models = [
  {
    id: "claude-opus-5-5",
    provider: "claude" as const,
    label: "Opus 5.5",
    efforts: ["low", "high", "max"] as ("low" | "high" | "max")[],
    defaultEffort: "high" as const,
  },
  { id: "haiku", provider: "claude" as const, label: "Haiku", efforts: [] },
];
it("App switches the actual StepTabs, LoopFlow and transcript together", () => {
  window.harness = {
    command: vi.fn(async () => ({ ok: true as const })),
    onEvent: () => () => {},
  };
  useStore.setState({
    app: {
      phase4: true,
      models,
      model: "claude-opus-5-5",
      effort: "high",
      fake: true,
      version: "test",
      currentSessionId: "s",
      workspaces: [],
      sessions: [
        {
          id: "s",
          title: "Test",
          cwd: "test",
          workspaceId: null,
          model: "claude-opus-5-5",
          effort: "high",
          readOnly: false,
          createdAt: 0,
          updatedAt: 0,
          status: "running",
          providers: [],
        },
      ],
    },
    views: {
      s: {
        items: [{ kind: "assistant", id: "main", text: "Main history" }],
        running: true,
        step: { step: 2, node: "model", round: 1 },
        agents: {
          w: {
            type: "agent",
            sessionId: "s",
            agentId: "w",
            name: "worker",
            model: "gpt-6.1-sol",
            status: "running",
            text: "Worker history",
          },
        },
        agentSteps: {
          w: {
            type: "agent_step",
            sessionId: "s",
            agentId: "w",
            step: "act",
            round: 3,
          },
        },
      },
    },
  });
  render(<App />);
  const hero = screen.getByRole("region", { name: "session overview" });
  const bar = screen.getByLabelText("AgentsPanel");
  expect(hero).toContainElement(bar);
  expect(bar.tagName).not.toBe("ASIDE");
  expect(
    screen.queryByRole("complementary", { name: "AgentsPanel" }),
  ).toBeNull();
  expect(screen.queryByText("Agents")).not.toBeInTheDocument();
  expect(screen.getByTestId("step-model")).toHaveAttribute(
    "aria-current",
    "step",
  );
  fireEvent.click(screen.getByRole("button", { name: /worker · gpt-6.1-sol/ }));
  expect(screen.getByTestId("step-act")).toHaveAttribute(
    "aria-current",
    "step",
  );
  expect(screen.getByText("Worker history")).toBeInTheDocument();
  expect(screen.queryByText("Main history")).not.toBeInTheDocument();
  expect(
    within(screen.getByRole("complementary", { name: "agent loop" })).getByText(
      "owner: gpt-6.1-sol",
    ),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /main · claude-opus/ }));
  expect(screen.getByText("Main history")).toBeInTheDocument();
});
it("auto-follow keeps main transcript while STEP follows the worker", () => {
  window.harness = {
    command: vi.fn(async () => ({ ok: true as const })),
    onEvent: () => () => {},
  };
  useStore.setState({
    app: {
      phase4: true,
      models,
      model: "claude-opus-5-5",
      effort: "high",
      fake: true,
      version: "test",
      currentSessionId: "s",
      workspaces: [],
      sessions: [
        {
          id: "s",
          title: "Test",
          cwd: "test",
          workspaceId: null,
          model: "claude-opus-5-5",
          effort: "high",
          readOnly: false,
          createdAt: 0,
          updatedAt: 0,
          status: "running",
          providers: [],
        },
      ],
    },
    views: {
      s: {
        items: [{ kind: "assistant", id: "main", text: "Main history" }],
        running: true,
        activeAgent: "w",
        agents: {
          w: {
            type: "agent",
            sessionId: "s",
            agentId: "w",
            name: "worker",
            model: "gpt-6.1-sol",
            status: "running",
          },
        },
        agentSteps: {
          w: {
            type: "agent_step",
            sessionId: "s",
            agentId: "w",
            step: "act",
            round: 3,
          },
        },
      },
    },
  });
  render(<App />);
  expect(screen.getByText("Main history")).toBeInTheDocument();
  expect(screen.getByTestId("step-act")).toHaveAttribute(
    "aria-current",
    "step",
  );
  fireEvent.click(screen.getByRole("button", { name: /worker · gpt-6.1-sol/ }));
  expect(screen.queryByText("Main history")).not.toBeInTheDocument();
  expect(
    screen.getByText("# worker の出力はまだありません"),
  ).toBeInTheDocument();
});
it("retains isolated child transcript and tracks the latest active STEP", () => {
  let state: EventState = { app: null, views: {} };
  state = applyEvent(state, {
    type: "agent",
    sessionId: "s",
    agentId: "w",
    name: "worker",
    model: "opus",
    status: "running",
  });
  state = applyEvent(state, {
    type: "text_delta",
    sessionId: "s",
    messageId: "m",
    text: "main",
  });
  state = applyEvent(state, {
    type: "agent_text",
    sessionId: "s",
    agentId: "w",
    text: "child",
  });
  state = applyEvent(state, {
    type: "agent_step",
    sessionId: "s",
    agentId: "w",
    step: "act",
    round: 2,
  });
  expect(state.views.s?.items[0]).toMatchObject({ text: "main" });
  expect(state.views.s?.agents?.w?.text).toBe("child");
  expect(state.views.s?.activeAgent).toBe("w");
  state = applyEvent(state, {
    type: "step",
    sessionId: "s",
    step: 6,
    node: "receipt",
    round: 1,
  });
  expect(state.views.s?.activeAgent).toBe("main");
});
it("AgentsPanel switches selection and shows permission and branch", () => {
  const select = vi.fn();
  render(
    <AgentsPanel
      model="opus"
      selected="main"
      onSelect={select}
      view={{
        items: [],
        running: true,
        pending: {
          agentId: "w",
          requestId: "p",
          tool: "Bash",
          summary: "test",
        },
        agents: {
          w: {
            type: "agent",
            sessionId: "s",
            agentId: "w",
            name: "worker",
            model: "sol",
            status: "running",
            branch: "xh/s-w1",
          },
        },
        agentSteps: {
          w: {
            type: "agent_step",
            sessionId: "s",
            agentId: "w",
            step: "gate",
            round: 1,
          },
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /worker · sol/ }));
  expect(select).toHaveBeenCalledWith("w");
  const button = screen.getByRole("button", {
    name: "worker · sol · 確認待ち · xh/s-w1",
  });
  expect(button).toHaveAttribute("title", "STEP gate");
  expect(screen.getByRole("button", { name: "自動追従" })).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "main · opus · 確認待ち" }),
  ).toHaveAttribute("aria-pressed", "true");
});
it("PhaseBar hides classification and provides transcript jumps and progress", () => {
  const jump = vi.fn();
  const { rerender } = render(
    <PhaseBar
      onJump={jump}
      view={{
        items: [],
        running: false,
        workflow: {
          type: "workflow",
          sessionId: "s",
          phase: "classify",
          reviewRound: 0,
          items: [],
          findings: [],
        },
      }}
    />,
  );
  expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  rerender(
    <PhaseBar
      onJump={jump}
      view={{
        items: [],
        running: true,
        workflow: {
          type: "workflow",
          sessionId: "s",
          phase: "implement",
          reviewRound: 0,
          items: [
            { id: "a", status: "integrated" },
            { id: "b", status: "running" },
          ],
          findings: [],
        },
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /1 PLAN/ }));
  expect(jump).toHaveBeenCalledWith("plan");
  expect(screen.getByText("1 / 2 項目 · 直列")).toBeInTheDocument();
});
it("ModelPicker offers catalog efforts, session apply and default separately", () => {
  const apply = vi.fn(async () => {}),
    defaults = vi.fn(async () => {}),
    close = vi.fn();
  render(
    <ModelPicker
      models={models}
      model="claude-opus-5-5"
      effort="high"
      onApply={apply}
      onDefault={defaults}
      onClose={close}
    />,
  );
  expect(
    within(screen.getByLabelText("effort")).getAllByRole("option"),
  ).toHaveLength(3);
  fireEvent.change(screen.getByLabelText("モデル"), {
    target: { value: "haiku" },
  });
  expect(screen.queryByLabelText("effort")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("apply · このセッション"));
  expect(apply).toHaveBeenCalledWith("haiku", undefined);
  expect(defaults).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("既定にする"));
  expect(defaults).toHaveBeenCalledWith("haiku", undefined);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).toHaveBeenCalled();
});
it("ModelPicker resolves an absent session model to the visible catalog option", () => {
  const apply = vi.fn(async () => {});
  render(
    <ModelPicker
      models={models}
      model="fake"
      effort="medium"
      onApply={apply}
      onClose={() => {}}
    />,
  );
  expect(screen.getByLabelText("モデル")).toHaveValue("claude-opus-5-5");
  expect(screen.getByLabelText("effort")).toHaveValue("high");
  fireEvent.click(screen.getByText("apply · このセッション"));
  expect(apply).toHaveBeenCalledWith("claude-opus-5-5", "high");
});
it.each(["y", "e", "n"])(
  "plan approval handles %s and preserves edits",
  (key) => {
    const approve = vi.fn(),
      revise = vi.fn(),
      deny = vi.fn();
    const item = {
      id: "a",
      title: "Write",
      files: ["a.ts"],
      dependsOn: [],
      assignee: {
        agent: "worker",
        model: "claude-opus-5-5",
        effort: "high",
        reason: "small",
      },
    };
    render(
      <PlanApproval
        plan={[item]}
        models={models}
        onApprove={approve}
        onDeny={deny}
        onRevise={revise}
      />,
    );
    fireEvent.change(screen.getByLabelText("a agent"), {
      target: { value: "main" },
    });
    fireEvent.keyDown(window, { key });
    if (key === "y")
      expect(approve).toHaveBeenCalledWith([
        expect.objectContaining({
          assignee: expect.objectContaining({ agent: "main" }),
        }),
      ]);
    if (key === "e") expect(revise).toHaveBeenCalledOnce();
    if (key === "n") expect(deny).toHaveBeenCalledOnce();
    expect(item.assignee.agent).toBe("worker");
  },
);
