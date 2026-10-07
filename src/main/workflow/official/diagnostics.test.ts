import { expect, it } from "vitest";
import { diagnostics } from "./diagnostics.js";
import type { AgentRequest } from "./contracts.js";

const request = (diagnosticText = false) =>
  ({
    requestId: "synthetic-request",
    model: { model: "haiku" },
    phase: "conversation",
    cwd: "synthetic",
    diagnosticText,
  }) as AgentRequest;
it("retains allowlisted version and model-switch evidence without notice prose", () => {
  const d = diagnostics(request(), "read-only", "plan");
  d.claude({
    type: "system",
    subtype: "init",
    model: "haiku",
    claude_code_version: "2.1.290",
  });
  d.claude({
    type: "system",
    subtype: "model_refusal_fallback",
    original_model: "haiku",
    fallback_model: "sonnet",
    content: "never-save-notice",
  });
  d.modelSwitch("sonnet", "opus", "auto");
  expect(d.data.cliVersion).toBe("2.1.290");
  expect(d.data.modelChanges).toHaveLength(2);
  expect(JSON.stringify(d.data)).not.toContain("never-save");
});
it("retains separate event model evidence and never thinking, secrets or unrequested text", () => {
  const d = diagnostics(request(true), "read-only", "plan");
  d.claude({ type: "system", subtype: "init", model: "haiku" });
  d.claude({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      model: "sonnet",
      content: [
        { type: "thinking", thinking: "never-save-thinking" },
        { type: "text", text: "main response" },
      ],
    },
  });
  d.claude({
    type: "assistant",
    parent_tool_use_id: "tool-helper",
    message: {
      model: "haiku",
      content: [{ type: "text", text: "never-save-helper-body" }],
    },
  });
  d.claude({
    type: "result",
    subtype: "success",
    modelUsage: {
      haiku: {
        inputTokens: 12,
        outputTokens: 3,
        account_id: "never-save-account",
      },
      sonnet: { inputTokens: 15 },
    },
  });
  expect(d.finish("completed")).toMatchObject({
    requestId: "synthetic-request",
    sdkInitialModels: ["haiku"],
    assistants: [
      { model: "sonnet", parentToolUseId: null },
      { model: "haiku", parentToolUseId: "tool-helper" },
    ],
    finalAnswer: "main response",
    termination: "success",
  });
  expect(JSON.stringify(d.data)).not.toMatch(/never-save/);
  d.answer(
    "Bearer secret-token access_token=secret-value " + "x".repeat(10000),
  );
  expect(d.data.finalAnswer).not.toMatch(/secret/);
  expect(d.data.finalAnswer!.length).toBeLessThanOrEqual(8000);
  const ordinary = diagnostics(request(), "read-only", "plan");
  ordinary.answer("private user response");
  expect(ordinary.data.finalAnswer).toBeUndefined();
});
it("does not mistake missing parent evidence for a main assistant", () => {
  const d = diagnostics(request(true), "read-only", "plan");
  d.claude({
    type: "assistant",
    message: {
      model: "haiku",
      content: [{ type: "text", text: "unknown role" }],
    },
  });
  expect(d.data.assistants[0]?.parentToolUseId).toBe("unknown");
  expect(d.data.finalAnswer).toBeUndefined();
});
