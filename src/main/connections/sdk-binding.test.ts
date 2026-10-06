import { expect, it, vi } from "vitest";
import type {
  Options,
  SDKMessage,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { officialSdkBinding } from "./sdk-binding.js";
import { ClaudeMcpDelegation, ClaudeProposals } from "./claude.js";
import { MemoryIntentLedger, ToolGateway } from "./boundary.js";
import { measureSdkResult } from "./measurement.js";
import type { Input } from "./contracts.js";

const input: Input = {
  taskId: "task",
  sessionId: "session",
  requestId: "request",
  model: "synthetic",
  instructions: "Fixture only",
  history: [{ role: "user", content: "OK" }],
  tools: [],
  timeoutMs: 500,
};
const signal = () => new AbortController().signal;
const events = [
  {
    type: "result",
    subtype: "success",
    result: "OK",
    structured_output: { answer: "OK", actions: [] },
  },
] as SDKMessage[];
it("closes an uncooperative SDK query on X timeout", async () => {
  const close = vi.fn();
  const binding = officialSdkBinding(
    { cwd: ".", subscriptionOnlyConfirmed: true, env: {} },
    () => ({
      close,
      async *[Symbol.asyncIterator]() {
        await new Promise(() => {});
        yield* events;
      },
    }),
  );
  const result = await new ClaudeProposals(binding).infer(
    { ...input, timeoutMs: 5 },
    signal(),
  );
  expect(result.status).toBe("timeout");
  expect(close).toHaveBeenCalled();
});
it.each(["A", "B"])(
  "binds %s to actual SDK Options and closes the query",
  async (variant) => {
    let captured: Options | undefined;
    const close = vi.fn();
    const start = vi.fn((request) => {
      captured = request.options;
      return {
        close,
        async *[Symbol.asyncIterator]() {
          yield* events;
        },
      };
    });
    const binding = officialSdkBinding(
      {
        cwd: ".",
        subscriptionOnlyConfirmed: true,
        env: {
          PATH: "synthetic",
          ANTHROPIC_API_KEY: "fixture-secret",
          OPENAI_API_KEY: "fixture-secret",
          NODE_OPTIONS: "fixture-danger",
        },
      },
      start,
    );
    const gateway = new ToolGateway(
      {
        taskId: input.taskId,
        sessionId: input.sessionId,
        requestId: input.requestId,
      },
      {},
      new MemoryIntentLedger(),
      async () => false,
    );
    const outcome =
      variant === "A"
        ? await new ClaudeProposals(binding).infer(input, signal())
        : await new ClaudeMcpDelegation(binding, gateway).delegate(
            input,
            signal(),
            () => {},
          );
    expect(outcome.status).toBe("completed");
    expect(captured).toMatchObject({
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      plugins: [],
      skills: [],
      settings: { autoMemoryEnabled: false },
      persistSession: false,
      permissionMode: "dontAsk",
    });
    expect(captured?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(captured?.env?.NODE_OPTIONS).toBeUndefined();
    expect(captured?.outputFormat !== undefined).toBe(variant === "A");
    expect(Object.keys(captured?.mcpServers ?? {})).toEqual(
      variant === "A" ? [] : ["xharness"],
    );
    expect(close).toHaveBeenCalled();
  },
);
it("uses real SDK tool/createSdkMcpServer over in-memory MCP and rejects malformed arguments", async () => {
  const execute = vi.fn(async () => ({
    content: [{ type: "text", text: "OK" }],
  }));
  const binding = officialSdkBinding({
    cwd: ".",
    subscriptionOnlyConfirmed: false,
    env: {},
  });
  const server = binding.createXServer({
    echo: execute,
  }) as McpSdkServerConfigWithInstance;
  const client = new Client({ name: "fixture", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(b);
  await client.connect(a);
  try {
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name)).toEqual(["echo"]);
    expect(
      await client.callTool({
        name: "echo",
        arguments: { id: "one", input: { text: "OK" } },
      }),
    ).toMatchObject({ content: [{ text: "OK" }] });
    expect(execute).toHaveBeenCalledWith({
      id: "one",
      tool: "echo",
      input: { text: "OK" },
    });
    expect(
      await client.callTool({
        name: "echo",
        arguments: { id: "../invalid", input: {} },
      }),
    ).toMatchObject({ isError: true });
    expect(execute).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.instance.close();
  }
});
it("does not start the real SDK without confirmed subscription-only conditions", async () => {
  const start = vi.fn(() => {
    throw new Error("Must not launch");
  });
  const binding = officialSdkBinding(
    { cwd: ".", subscriptionOnlyConfirmed: false, env: {} },
    start,
  );
  expect(
    (await new ClaudeProposals(binding).infer(input, signal())).error,
  ).toBe("unconfigured");
  expect(start).not.toHaveBeenCalled();
});
it("accounts query-pipeline modelUsage once and leaves missing components unknown", () => {
  const event = {
    modelUsage: {
      main: {
        inputTokens: 10,
        outputTokens: 3,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
      helper: {
        inputTokens: 4,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    usage: { input_tokens: 999, output_tokens: 999 },
  };
  expect(measureSdkResult(event)).toMatchObject({ input: 17, output: 4 });
  expect(
    measureSdkResult({ modelUsage: { main: { inputTokens: 10 } } }),
  ).toMatchObject({ input: null, output: null });
  expect(
    measureSdkResult({
      subtype: "error_during_execution",
      modelUsage: {},
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  ).toBeNull();
});
it("stops on SDK quota/overage rather than continuing to an extra-charge path", async () => {
  const quotaEvents = [
    {
      type: "rate_limit_event",
      session_id: "fixture",
      uuid: "00000000-0000-0000-0000-000000000001",
      rate_limit_info: { status: "rejected", utilization: 0.8, resetsAt: 1234 },
    },
  ] as SDKMessage[];
  const close = vi.fn();
  const binding = officialSdkBinding(
    { cwd: ".", subscriptionOnlyConfirmed: true, env: {} },
    () => ({
      close,
      async *[Symbol.asyncIterator]() {
        yield* quotaEvents;
      },
    }),
  );
  const result = await new ClaudeProposals(binding).infer(input, signal());
  expect(result).toMatchObject({
    status: "quota-paused",
    quota: {
      source: "sdk-event",
      usedPercent: null,
      native: { utilization: 0.8 },
    },
  });
  expect(close).toHaveBeenCalled();
});
