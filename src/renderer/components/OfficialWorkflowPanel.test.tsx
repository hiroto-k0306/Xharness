import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialWorkflowPanel } from "./OfficialWorkflowPanel.js";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
const QUESTION_MODELS = {
  claude: "claude-question-x",
  codex: "codex-question-y",
};
afterEach(() => vi.unstubAllGlobals());
it.each([true, false])(
  "shows concrete operation and sends one bound decision (%s)",
  async (allow) => {
    const pending = {
      workflowId: "workflow",
      approvalId: "nonce",
      digest: "a".repeat(64),
      expiresAt: Date.now() + 60000,
      requestId: "request",
      sessionId: "session",
      turnId: "turn",
      itemId: "item",
      command: "Get-Content add.mjs",
      cwd: "isolated workspace",
      targets: ["add.mjs"],
      reason: "Inspect the implementation",
    };
    const view: OfficialWorkflowView = {
      available: true,
      simulated: true,
      activeId: "workflow",
      operationApproval: pending,
      records: [],
    };
    let release!: () => void;
    const commands: OfficialWorkflowCommand[] = [];
    const officialWorkflow = vi.fn(async (command: OfficialWorkflowCommand) => {
      commands.push(command);
      if (command.action === "tool_decision")
        await new Promise<void>((r) => {
          release = r;
        });
      return view;
    });
    vi.stubGlobal("harness", { officialWorkflow });
    render(<OfficialWorkflowPanel />);
    fireEvent.click(screen.getByRole("button", { name: "公式workflow" }));
    await screen.findByRole("alertdialog", { name: "今回の操作の承認" });
    expect(screen.getByText(/操作：/)).toHaveTextContent(pending.command);
    expect(screen.getByText(/作業場所：/)).toHaveTextContent(pending.cwd);
    const button = screen.getByRole("button", {
      name: allow ? "今回の操作だけ許可" : "拒否",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(commands.filter((c) => c.action === "tool_decision")).toEqual([
        {
          action: "tool_decision",
          id: "workflow",
          approvalId: "nonce",
          digest: pending.digest,
          allow,
        },
      ]),
    );
    release();
    await waitFor(() => expect(button).not.toBeDisabled());
  },
);
it.each(["claude", "codex"] as const)(
  "displays the same fixed question model the service selects and sends to that company (%s)",
  async (provider) => {
    const view: OfficialWorkflowView = {
      available: true,
      storageReady: true,
      simulated: false,
      questionModels: {
        claude: { id: QUESTION_MODELS.claude },
        codex: { id: QUESTION_MODELS.codex },
      },
      connection: {
        codexPath: "C:/codex.exe",
        workspaceRoot: "",
        status: "configured",
        message: "configured",
      },
      records: [],
    };
    const commands: OfficialWorkflowCommand[] = [];
    vi.stubGlobal("harness", {
      officialWorkflow: vi.fn(async (command: OfficialWorkflowCommand) => {
        commands.push(command);
        return view;
      }),
    });
    render(
      <OfficialWorkflowPanel
        mainModel={provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol"}
        mainEffort="high"
        mainProvider={provider}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "公式workflow" }));
    await waitFor(() =>
      expect(screen.getByLabelText("質問先")).toHaveTextContent(
        QUESTION_MODELS[provider],
      ),
    );
    fireEvent.change(screen.getByLabelText("公式接続への質問"), {
      target: { value: "質問" },
    });
    fireEvent.click(screen.getByRole("button", { name: "質問だけ送信" }));
    await waitFor(() =>
      expect(commands.filter((c) => c.action === "chat")).toEqual([
        { action: "chat", provider, text: "質問" },
      ]),
    );
  },
);
