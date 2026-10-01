import { describe, expect, it } from "vitest";
import { runTurn, type LoopOptions, type StepName } from "./loop.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "../providers/provider.js";
import { type Tool } from "../tools/registry.js";

function completion(tool = false): ProviderEvent {
  return {
    type: "message_done",
    message: {
      role: "assistant",
      content: tool
        ? [
            {
              type: "tool_use",
              id: "call_1",
              name: "Read",
              input: { path: "a.txt" },
            },
          ]
        : [{ type: "text", text: "done" }],
    },
    stopReason: tool ? "tool_use" : "end_turn",
    usage: { inputTokens: 10, outputTokens: 2 },
  };
}
function setup(responses: ProviderEvent[][]) {
  const requests: ProviderRequest[] = [];
  let executions = 0;
  const tool: Tool = {
    spec: {
      name: "Read",
      description: "Read",
      inputSchema: { type: "object" },
    },
    readOnly: true,
    validate: async () => undefined,
    execute: async () => {
      executions++;
      return { content: "file contents" };
    },
  };
  const provider: Provider = {
    id: "claude",
    models: () => [],
    async *stream(req) {
      requests.push(structuredClone(req));
      yield* responses.shift() ?? [completion()];
    },
  };
  const options: LoopOptions = {
    provider,
    model: "test",
    system: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "start" }] }],
    tools: new Map([["Read", tool]]),
    permission: async () => true,
  };
  return { options, requests, executions: () => executions };
}
describe("six-step agent loop", () => {
  it("only appends history and preserves thinking on the next model call", async () => {
    const toolMessage = completion(true) as Extract<
      ProviderEvent,
      { type: "message_done" }
    >;
    const native = Object.freeze({
      type: "thinking",
      thinking: "original thought",
      signature: "original signature",
    });
    toolMessage.message.content.unshift({
      type: "reasoning",
      provider: "claude",
      payload: native,
    });
    const { options, requests } = setup([[toolMessage], [completion()]]);
    const before = structuredClone(options.messages);
    const result = await runTurn(options, new AbortController().signal);
    expect(options.messages).toEqual(before);
    expect(result.messages.slice(0, before.length)).toEqual(before);
    expect(requests[1]!.messages[1]!.content[0]).toEqual({
      type: "reasoning",
      provider: "claude",
      payload: native,
    });
    expect(toolMessage.message.content[0]).toEqual({
      type: "reasoning",
      provider: "claude",
      payload: native,
    });
  });
  it("calls before/after hooks, sends tool_result, and records every round", async () => {
    const { options, requests, executions } = setup([
      [completion(true)],
      [completion()],
    ]);
    const hooks: string[] = [];
    options.beforeStep = async (step, ctx) => {
      hooks.push(`${ctx.round}:before:${step}`);
      return { kind: "continue" };
    };
    options.afterStep = async (step, ctx) => {
      hooks.push(`${ctx.round}:after:${step}`);
      return { kind: "continue" };
    };
    const result = await runTurn(options, new AbortController().signal);
    const first: StepName[] = [
      "context",
      "model",
      "tool_use",
      "gate",
      "act",
      "receipt",
    ];
    expect(hooks.slice(0, 12)).toEqual(
      first.flatMap((step) => [`1:before:${step}`, `1:after:${step}`]),
    );
    expect(executions()).toBe(1);
    expect(requests[1]!.messages.at(-1)?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "call_1",
        content: "file contents",
        isError: undefined,
      },
    ]);
    expect(result.stopCause).toBe("end_turn");
    expect(
      result.receipts.filter((receipt) => receipt.provider !== "hook"),
    ).toHaveLength(3);
    for (const receipt of result.receipts)
      expect(new Date(receipt.completedAt).toISOString()).toBe(
        receipt.completedAt,
      );
  });
  it("returns a denied tool result without executing", async () => {
    const { options, executions } = setup([[completion(true)], [completion()]]);
    options.permission = async () => false;
    const result = await runTurn(options, new AbortController().signal);
    expect(executions()).toBe(0);
    expect(result.messages[2]!.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "call_1",
      isError: true,
      content: "Permission denied by user",
    });
  });
  it("rechecks the precondition after waiting for permission", async () => {
    const { options, executions } = setup([[completion(true)], [completion()]]);
    let changed = false;
    options.tools.get("Read")!.validate = async () =>
      changed ? "File changed" : undefined;
    options.permission = async () => {
      changed = true;
      return true;
    };
    const result = await runTurn(options, new AbortController().signal);
    expect(executions()).toBe(0);
    expect(result.messages[2]!.content[0]).toMatchObject({
      content: "File changed",
      isError: true,
    });
  });
  it("closes all tool IDs and writes receipts when permission is interrupted", async () => {
    const { options, executions } = setup([[completion(true)]]);
    const controller = new AbortController();
    options.permission = async () => {
      controller.abort();
      throw new Error("Interrupted");
    };
    const result = await runTurn(options, controller.signal);
    expect(result.stopCause).toBe("aborted");
    expect(executions()).toBe(0);
    expect(result.messages.at(-1)?.content).toEqual([
      {
        type: "tool_result",
        toolUseId: "call_1",
        content: "Interrupted by user",
        isError: true,
      },
    ]);
    expect(result.receipts).toHaveLength(2);
  });
  it("blocks the fourth identical call and stops after five consecutive errors", async () => {
    const { options, executions } = setup(
      Array.from({ length: 8 }, () => [completion(true)]),
    );
    const result = await runTurn(options, new AbortController().signal);
    expect(executions()).toBe(3);
    expect(result.stopCause).toBe("consecutive_errors");
    expect(result.messages.at(-1)?.content[0]).toMatchObject({ isError: true });
  });
  it("retries transient failures but does not guess a missing 429 wait", async () => {
    const failure: ProviderEvent = {
      type: "error",
      error: { kind: "transport", message: "safe", retryable: true },
    };
    const { options, requests } = setup([[failure], [failure], [completion()]]);
    const delays: number[] = [];
    options.sleep = async (ms) => {
      delays.push(ms);
    };
    const result = await runTurn(options, new AbortController().signal);
    expect(result.stopCause).toBe("end_turn");
    expect(requests).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
    const other = setup([[{ type: "rate_limited" }]]);
    expect(
      (await runTurn(other.options, new AbortController().signal)).stopCause,
    ).toBe("rate_limited");
    expect(other.requests).toHaveLength(1);
  });
  it("does not start a mutation after five errors in the same response", async () => {
    const event = completion(true) as Extract<
      ProviderEvent,
      { type: "message_done" }
    >;
    event.message.content = Array.from({ length: 5 }, (_, index) => ({
      type: "tool_use",
      id: `bad_${index}`,
      name: "Unknown",
      input: {},
    }));
    event.message.content.push({
      type: "tool_use",
      id: "write",
      name: "Read",
      input: { path: "a.txt" },
    });
    const { options, executions } = setup([[event]]);
    options.tools.get("Read")!.readOnly = false;
    const result = await runTurn(options, new AbortController().signal);
    expect(result.stopCause).toBe("consecutive_errors");
    expect(executions()).toBe(0);
    expect(result.messages.at(-1)?.content).toHaveLength(6);
  });
  it("limits max_tokens continuations to two", async () => {
    const limited = {
      ...completion(),
      stopReason: "max_tokens",
    } as ProviderEvent;
    const { options, requests } = setup([[limited], [limited], [limited]]);
    const result = await runTurn(options, new AbortController().signal);
    expect(requests).toHaveLength(3);
    expect(result.stopCause).toBe("max_tokens");
  });
  it("keeps history valid at the round limit and scrubs tool output", async () => {
    const { options } = setup([[completion(true)]]);
    options.maxRounds = 1;
    options.redact = (text) => text.replace("file", "masked");
    const result = await runTurn(options, new AbortController().signal);
    expect(result.stopCause).toBe("round_limit");
    expect(result.messages.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      content: "masked contents",
    });
  });
});
