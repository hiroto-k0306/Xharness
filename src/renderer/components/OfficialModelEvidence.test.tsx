import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { OfficialModelEvidence } from "./OfficialModelEvidence.js";
import type { AgentDiagnostics } from "../../main/workflow/official/diagnostics.js";
it("shows mismatched main model without relabeling it as auxiliary", () => {
  const data: AgentDiagnostics = {
    requestId: "test",
    requestedModel: "haiku",
    resolvedRequestedModel: "claude-haiku",
    phase: "conversation",
    cwd: "test",
    sandbox: "read-only",
    approval: "plan",
    tools: [],
    sdkInitialModels: ["claude-haiku"],
    assistants: [
      { model: "claude-sonnet", parentToolUseId: null },
      { model: "claude-haiku", parentToolUseId: "helper" },
      { model: "unknown-model", parentToolUseId: "unknown" },
    ],
    resultModelUsage: [
      { model: "claude-sonnet", tokens: { inputTokens: 12, outputTokens: 4 } },
    ],
  };
  render(<OfficialModelEvidence data={data} />);
  expect(screen.getByRole("alert")).toHaveTextContent("モデル不一致");
  expect(screen.getByText(/主系列assistant/)).toHaveTextContent(
    "claude-sonnet",
  );
  expect(screen.getByText(/補助系列/)).not.toHaveTextContent("claude-sonnet");
  expect(screen.getByText(/parent欠測/)).toHaveTextContent("1件");
});
