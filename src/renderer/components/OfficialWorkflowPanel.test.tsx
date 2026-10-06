import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OfficialWorkflowPanel } from "./OfficialWorkflowPanel.js";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
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
