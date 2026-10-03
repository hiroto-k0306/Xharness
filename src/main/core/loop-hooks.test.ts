import { describe, expect, it } from "vitest";
import {
  runTurn,
  createLoopContext,
  createSteps,
  transition,
  type LoopOptions,
  type StepOutcome,
} from "./loop.js";
import {
  type ProviderEvent,
  type ProviderRequest,
} from "../providers/provider.js";
import { type HookResult } from "../hooks/step-hooks.js";

function setup() {
  const requests: ProviderRequest[] = [];
  let executions = 0;
  const thought = {
    type: "thinking",
    thinking: "keep this",
    signature: "opaque-signature",
  };
  const reply = (tool: boolean): ProviderEvent => ({
    type: "message_done",
    message: {
      role: "assistant",
      content: tool
        ? [
            { type: "reasoning", provider: "claude", payload: thought },
            { type: "tool_use", id: "read_1", name: "Read", input: {} },
          ]
        : [{ type: "text", text: "done" }],
    },
    stopReason: tool ? "tool_use" : "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  const responses: ProviderEvent[][] = [[reply(true)], [reply(false)]];
  const options: LoopOptions = {
    model: "test",
    system: "system",
    messages: [{ role: "user", content: [{ type: "text", text: "start" }] }],
    provider: {
      id: "claude",
      models: () => [],
      async *stream(request) {
        requests.push(structuredClone(request));
        yield* responses.shift() ?? [reply(false)];
      },
    },
    tools: new Map([
      [
        "Read",
        {
          spec: { name: "Read", description: "Read", inputSchema: {} },
          readOnly: true,
          validate: async () => undefined,
          execute: async () => {
            executions++;
            return { content: "original output" };
          },
        },
      ],
    ]),
    permission: async () => true,
  };
  return {
    options,
    requests,
    responses,
    thought,
    executions: () => executions,
  };
}
const signal = () => new AbortController().signal;
const proceed: HookResult = { kind: "continue" };
describe("HookResult behavior", () => {
  it("runs the after hook when a STEP fails and keeps the exception private", async () => {
    const { options } = setup();
    options.provider.stream = async function* () {
      yield { type: "text_delta", text: "partial" };
      throw new Error("private exception");
    };
    const after: string[] = [];
    options.afterStep = async (step) => {
      after.push(step);
      return proceed;
    };
    const result = await runTurn(options, signal());
    expect(after).toContain("model");
    expect(result.stopCause).toBe("step_failed");
    expect(result.messages).toEqual(options.messages);
    expect(JSON.stringify(result.receipts)).not.toContain("private exception");
  });
  it("records the round exactly once even when a receipt observer throws", async () => {
    const { options } = setup();
    options.onEvent = (event) => {
      if (event.type === "receipt") throw new Error("observer failed");
    };
    const result = await runTurn(options, signal());
    expect(result.stopCause).toBe("step_failed");
    expect(result.receipts).toHaveLength(2);
    expect(result.messages.at(-1)?.content[0]).toMatchObject({
      toolUseId: "read_1",
    });
  });
  it("treats an empty stop reason as a failed hook instead of continuing", async () => {
    const { options, requests } = setup();
    options.beforeStep = async () => ({ kind: "stop", reason: "" });
    const result = await runTurn(options, signal());
    expect(requests).toHaveLength(0);
    expect(result.stopCause).toBe("hook_failed");
  });
  it("injects before model by appending a message without changing old history", async () => {
    const { options, requests } = setup();
    const before = structuredClone(options.messages);
    options.beforeStep = async (step, ctx) =>
      step === "model" && ctx.round === 1
        ? { kind: "inject", message: "extra context" }
        : proceed;
    const result = await runTurn(options, signal());
    expect(requests[0]!.messages.slice(0, before.length)).toEqual(before);
    expect(requests[0]!.messages.at(-1)?.content).toEqual([
      { type: "text", text: "extra context" },
    ]);
    expect(options.messages).toEqual(before);
    expect(result.receipts).toContainEqual(
      expect.objectContaining({ provider: "hook", decision: "inject" }),
    );
  });
  it("adds after-act injection to a tool result and leaves thinking unchanged", async () => {
    const { options, requests, thought } = setup();
    options.afterStep = async (step) =>
      step === "act"
        ? { kind: "inject", message: "lint information" }
        : proceed;
    const result = await runTurn(options, signal());
    expect(requests[1]!.messages.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      content: "original output\nlint information",
    });
    expect(requests[1]!.messages[1]!.content[0]).toEqual({
      type: "reasoning",
      provider: "claude",
      payload: thought,
    });
    expect(result.stopCause).toBe("end_turn");
  });
  it("blocks act without executing and returns its reason to the model", async () => {
    const { options, requests, executions } = setup();
    options.beforeStep = async (step) =>
      step === "act" ? { kind: "block", reason: "protected file" } : proceed;
    const result = await runTurn(options, signal());
    expect(executions()).toBe(0);
    expect(requests[1]!.messages.at(-1)?.content[0]).toMatchObject({
      toolUseId: "read_1",
      content: expect.stringContaining("protected file"),
      isError: true,
    });
    expect(result.stopCause).toBe("end_turn");
  });
  it("stops before gate, closes tool IDs, and skips permission/execution", async () => {
    const { options, executions, requests } = setup();
    let asked = false;
    options.permission = async () => {
      asked = true;
      return true;
    };
    options.beforeStep = async (step) =>
      step === "gate" ? { kind: "stop", reason: "user hook stopped" } : proceed;
    const result = await runTurn(options, signal());
    expect(result.stopCause).toBe("user hook stopped");
    expect(asked).toBe(false);
    expect(executions()).toBe(0);
    expect(requests).toHaveLength(1);
    expect(result.messages.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "read_1",
      isError: true,
    });
    expect(result.receipts.filter((r) => r.provider !== "hook")).toHaveLength(
      2,
    );
  });
  it("keeps a receipt hook failure from dropping tool results or duplicating records", async () => {
    const { options } = setup();
    options.beforeStep = async (step) => {
      if (step === "receipt") throw new Error("private exception");
      return proceed;
    };
    const result = await runTurn(options, signal());
    expect(result.stopCause).toBe("hook_failed");
    expect(result.messages.at(-1)?.content[0]).toMatchObject({
      toolUseId: "read_1",
      content: "original output",
    });
    expect(result.receipts.filter((r) => r.provider !== "hook")).toHaveLength(
      2,
    );
    expect(JSON.stringify(result.receipts)).not.toContain("private exception");
  });
  it("rejects after-block and preserves an already executed tool result", async () => {
    const { options, executions } = setup();
    options.afterStep = async (step) =>
      step === "act" ? { kind: "block", reason: "too late" } : proceed;
    const result = await runTurn(options, signal());
    expect(result.stopCause).toBe("hook_failed");
    expect(executions()).toBe(1);
    expect(result.messages.at(-1)?.content[0]).toMatchObject({
      content: "original output",
    });
  });
  it("prevents a hook from mutating the history snapshot", async () => {
    const { options } = setup();
    const before = structuredClone(options.messages);
    options.beforeStep = async (_step, ctx) => {
      // Simulate an untyped future plug-in circumventing compile-time readonly.
      const messages = ctx.messages as unknown as ProviderRequest["messages"];
      messages[0]!.content.push({ type: "text", text: "mutation" });
      return proceed;
    };
    const result = await runTurn(options, signal());
    expect(result.stopCause).toBe("hook_failed");
    expect(result.messages).toEqual(before);
    expect(options.messages).toEqual(before);
  });
  it("continues after receipt injection without modifying prior messages", async () => {
    const { options, requests } = setup();
    options.afterStep = async (step, ctx) =>
      step === "receipt" && ctx.round === 2
        ? { kind: "inject", message: "check another thing" }
        : proceed;
    const result = await runTurn(options, signal());
    expect(requests).toHaveLength(3);
    expect(
      requests[2]!.messages.slice(0, requests[1]!.messages.length),
    ).toEqual(requests[1]!.messages);
    expect(requests[2]!.messages.at(-1)?.content).toEqual([
      { type: "text", text: "check another thing" },
    ]);
    expect(result.stopCause).toBe("end_turn");
  });
});
describe("inject never rewrites what the model already received", () => {
  // 各リクエストは先頭が前回と完全一致し、末尾にだけ追記される(送信済み部分は不変)。
  const prefixOf = (later: ProviderRequest, earlier: ProviderRequest) =>
    later.messages.slice(0, earlier.messages.length);
  it("keeps a sent tool_result unchanged when a later hook injects", async () => {
    const { options, requests, responses, thought } = setup();
    // round1: tool_use → round2: tool_use(同じ Read を別 id で) → round3: 終了
    responses.splice(
      0,
      responses.length,
      [
        {
          type: "message_done",
          message: {
            role: "assistant",
            content: [
              { type: "reasoning", provider: "claude", payload: thought },
              { type: "tool_use", id: "read_1", name: "Read", input: { n: 1 } },
            ],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ],
      [
        {
          type: "message_done",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "read_2", name: "Read", input: { n: 2 } },
            ],
          },
          stopReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ],
      [
        {
          type: "message_done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      ],
    );
    options.afterStep = async (step, ctx) =>
      step === "act" && ctx.round === 2
        ? { kind: "inject", message: "late note" }
        : step === "act" && ctx.round === 1
          ? { kind: "inject", message: "early note" }
          : proceed;
    const result = await runTurn(options, signal());
    expect(requests).toHaveLength(3);
    // round1 の inject は round2 の要求に入る。round2 の inject は round3 の要求に入る。
    const sentFirst = structuredClone(requests[1]!.messages);
    expect(prefixOf(requests[2]!, requests[1]!)).toEqual(sentFirst);
    expect(requests[1]!.messages.at(-1)?.content[0]).toMatchObject({
      toolUseId: "read_1",
      content: "original output\nearly note",
    });
    // round3 では read_1 の結果から "late note" が漏れ込んでいない
    expect(JSON.stringify(requests[2]!.messages.slice(0, 3))).not.toContain(
      "late note",
    );
    expect(requests[2]!.messages.at(-1)?.content[0]).toMatchObject({
      toolUseId: "read_2",
      content: "original output\nlate note",
    });
    expect(result.stopCause).toBe("end_turn");
  });
  it("never edits earlier messages when injecting at the receipt step", async () => {
    const { options, requests } = setup();
    options.afterStep = async (step, ctx) =>
      step === "receipt"
        ? { kind: "inject", message: `note ${ctx.round}` }
        : proceed;
    // receipt 後の inject は最終ターンを延長する。maxRounds で止める。
    options.maxRounds = 4;
    await runTurn(options, signal());
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < requests.length; i++)
      expect(prefixOf(requests[i]!, requests[i - 1]!)).toEqual(
        requests[i - 1]!.messages,
      );
  });
  it("does not change the history returned for earlier messages or the caller's input", async () => {
    const { options, requests } = setup();
    const original = structuredClone(options.messages);
    options.beforeStep = async (step) =>
      step === "context"
        ? { kind: "inject", message: "context note" }
        : proceed;
    const result = await runTurn(options, signal());
    expect(options.messages).toEqual(original);
    expect(result.messages.slice(0, original.length)).toEqual(original);
    for (let i = 1; i < requests.length; i++)
      expect(prefixOf(requests[i]!, requests[i - 1]!)).toEqual(
        requests[i - 1]!.messages,
      );
  });
});
describe("independent STEP outcomes", () => {
  it("runs all six STEP units against an isolated context", async () => {
    const { options, executions } = setup();
    const ctx = createLoopContext(options);
    const steps = createSteps(options);
    for (const [step, to] of [
      ["context", "model"],
      ["model", "tool_use"],
      ["tool_use", "gate"],
      ["gate", "act"],
      ["act", "receipt"],
      ["receipt", "context"],
    ] as const)
      expect(await steps[step].run(ctx, signal())).toEqual({
        kind: "next",
        to,
      });
    expect(executions()).toBe(1);
    expect(ctx.messages.at(-1)?.content[0]).toMatchObject({
      type: "tool_result",
      toolUseId: "read_1",
    });
  });
  it("returns retry from model and keeps failed partial history uncommitted", async () => {
    const { options, responses } = setup();
    responses.splice(0, responses.length, [
      { type: "text_delta", text: "partial" },
      {
        type: "error",
        error: { kind: "transport", message: "safe", retryable: true },
      },
    ]);
    const ctx = createLoopContext(options);
    const steps = createSteps(options);
    await steps.context.run(ctx, signal());
    expect(await steps.model.run(ctx, signal())).toEqual({
      kind: "retry",
      afterMs: 1000,
    });
    expect(ctx.messages).toEqual(options.messages);
  });
  it("dispatches next, retry, fallback and stop explicitly", () => {
    const cases: [StepOutcome, string | undefined][] = [
      [{ kind: "next", to: "gate" }, "gate"],
      [{ kind: "retry", afterMs: 1 }, "model"],
      [
        { kind: "fallback", to: "context", reason: "different model" },
        "context",
      ],
      [{ kind: "stop", reason: "done" }, undefined],
    ];
    for (const [outcome, expected] of cases)
      expect(transition("model", outcome)).toBe(expected);
  });
});

describe("per-round model selection", () => {
  it("applies a model/effort change from the next round, not mid-call", async () => {
    const { options, requests } = setup();
    let current: { model: string; reasoning: { effort: "high" | "low" } } = {
      model: "first",
      reasoning: { effort: "high" },
    };
    options.current = () => current;
    // 1周目の act の後(=2周目の STEP 1 より前)に切り替える
    options.afterStep = async (step, ctx) => {
      if (step === "act" && ctx.round === 1)
        current = { model: "second", reasoning: { effort: "low" } };
      return proceed;
    };
    const result = await runTurn(options, signal());
    expect(requests.map((r) => [r.model, r.reasoning?.effort])).toEqual([
      ["first", "high"],
      ["second", "low"],
    ]);
    expect(
      result.receipts
        .filter((r) => r.provider === "claude")
        .map((r) => r.model),
    ).toEqual(["first", "second"]);
  });
});
