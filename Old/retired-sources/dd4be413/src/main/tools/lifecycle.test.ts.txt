import { expect, it, vi } from "vitest";
import { lifecycleTools } from "./lifecycle.js";
import { runTurn } from "../core/loop.js";
import { type Provider, type ProviderEvent } from "../providers/provider.js";
import { type ContentBlock } from "../core/types.js";

it.each(["claude", "codex"] as const)(
  "%s stops immediately, closes sibling IDs and masks the displayed reason",
  async (id) => {
    const permission = vi.fn(async () => true);
    const execute = vi.fn(async () => ({ content: "side effect" }));
    const tools = lifecycleTools();
    tools.set("Write", {
      spec: { name: "Write", description: "write", inputSchema: {} },
      readOnly: false,
      validate: async () => undefined,
      execute,
    });
    let calls = 0;
    const provider: Provider = {
      id,
      models: () => [],
      async *stream() {
        calls++;
        yield {
          type: "message_done",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "write", name: "Write", input: {} },
              {
                type: "tool_use",
                id: "stop",
                name: "StopTask",
                input: { reason: "synthetic-secretの確認が必要" },
              },
            ],
          },
        } as ProviderEvent;
      },
    };
    const result = await runTurn(
      {
        provider,
        model: "test",
        system: "test",
        messages: [],
        tools,
        permission,
        redact: (s) => s.replaceAll("synthetic-secret", "[masked]"),
        afterStep: async (step) =>
          step === "receipt"
            ? { kind: "inject", message: "Keep working" }
            : { kind: "continue" },
      },
      new AbortController().signal,
    );
    expect(result.stopCause).toBe("agent_stopped");
    expect(calls).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
    const results = result.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result");
    expect(results.map((b) => b.toolUseId)).toEqual(["write", "stop"]);
    expect(results[0]?.isError).toBe(true);
    expect(JSON.stringify(result.messages.slice(1))).not.toContain(
      "synthetic-secret",
    );
    expect(
      result.messages.some(
        (m) =>
          m.role === "assistant" &&
          m.content.some(
            (b) => b.type === "text" && b.text.includes("[masked]"),
          ),
      ),
    ).toBe(true);
  },
);

it("asks once with suggested answers and waits without another LLM request", async () => {
  let calls = 0;
  const provider: Provider = {
    id: "codex",
    models: () => [],
    async *stream() {
      calls++;
      yield {
        type: "message_done",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "ask",
              name: "AskUserQuestion",
              input: {
                question: "どちらにしますか？",
                options: ["案A", "案B"],
              },
            },
          ],
        },
      } as ProviderEvent;
    },
  };
  const result = await runTurn(
    {
      provider,
      model: "test",
      system: "test",
      messages: [],
      tools: lifecycleTools(),
      permission: async () => false,
    },
    new AbortController().signal,
  );
  expect(result.stopCause).toBe("awaiting_user");
  expect(calls).toBe(1);
  expect(result.messages.at(-1)?.content).toEqual([
    {
      type: "text",
      text: "確認が必要です：どちらにしますか？\n1. 案A\n2. 案B",
    },
  ]);
});

it("invalid control arguments return an error and allow correction on the next request", async () => {
  let calls = 0;
  const provider: Provider = {
    id: "claude",
    models: () => [],
    async *stream() {
      const content: ContentBlock[] =
        ++calls === 1
          ? [
              {
                type: "tool_use",
                id: "bad",
                name: "AskUserQuestion",
                input: { question: "", options: ["only one"] },
              },
            ]
          : [{ type: "text", text: "corrected" }];
      yield {
        type: "message_done",
        stopReason: calls === 1 ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
      } as ProviderEvent;
    },
  };
  const result = await runTurn(
    {
      provider,
      model: "test",
      system: "test",
      messages: [],
      tools: lifecycleTools(),
      permission: async () => true,
    },
    new AbortController().signal,
  );
  expect(result.stopCause).toBe("end_turn");
  expect(calls).toBe(2);
  expect(result.messages[1]?.content[0]).toMatchObject({
    type: "tool_result",
    isError: true,
  });
});

it.each([
  { reason: " " },
  { reason: "x", options: ["a", "b"] },
  { reason: "x", unknown: true },
  { reason: "x".repeat(4001) },
])("rejects malformed StopTask input %j", async (input) => {
  const tool = lifecycleTools().get("StopTask")!;
  expect(await tool.validate(input)).toBeTruthy();
  expect(await tool.execute(input, new AbortController().signal)).toMatchObject(
    { isError: true },
  );
});
