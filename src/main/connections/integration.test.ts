import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FileIntentLedger } from "./ledger.js";
import { runConnectedTurn } from "./integration.js";
import { runDevelopmentConnection } from "./development.js";
import { acquireHomeWriter } from "../home-writer.js";
import { SessionStore } from "../session/store.js";
import { readTraceReplay } from "../session/report-trace.js";
import { normalizeTokens } from "../providers/token-usage.js";
import type { SdkBinding } from "./claude.js";
import type { LoopOptions } from "../core/loop.js";

const scope = { taskId: "task", sessionId: "session", requestId: "one" };
const action = { id: "one", tool: "Echo", input: { text: "OK" } };
const usage = {
  input_tokens: 2,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const signal = () => new AbortController().signal;
const home = () => mkdtemp(join(tmpdir(), "xh-connection-test-"));
const options = (
  execute = vi.fn(async () => ({ content: "OK" })),
): LoopOptions => ({
  sessionId: "session",
  model: "fixture",
  system: "Fixture",
  messages: [{ role: "user", content: [{ type: "text", text: "Echo OK" }] }],
  provider: {
    id: "claude",
    models: () => [],
    stream() {
      throw new Error("Legacy provider must not run");
    },
  },
  tools: new Map([
    [
      "Echo",
      {
        readOnly: true,
        spec: {
          name: "Echo",
          description: "Fixture",
          inputSchema: { type: "object" },
        },
        validate: async (value) =>
          value && typeof value === "object" ? undefined : "invalid",
        execute,
      },
    ],
  ]),
  permission: async () => true,
  maxRounds: 3,
});
it("retains observed partial usage on failure without counting SDK replay twice", async () => {
  const dir = await home();
  const partial = { type: "assistant", message: { id: "response-one", usage } };
  const sdk: SdkBinding = {
    subscriptionUseConfirmed: true,
    createXServer: (h) => h,
    async *query() {
      yield partial;
      yield partial;
      yield { type: "result", subtype: "error_during_execution" };
    },
  };
  const result = await runDevelopmentConnection(
    dir,
    process.cwd(),
    "Fixture",
    { mode: "claude-proposals", sdk, simulated: true },
    options(),
    new AbortController(),
  );
  const replay = await readTraceReplay(dir, result.sessionId, (text) => text);
  const end = replay?.records.find(
    (r) => r.kind === "llm" && r.phase === "end",
  );
  const data = end?.output as {
    tokenMeasurement: Parameters<typeof normalizeTokens>[0];
  };
  expect(normalizeTokens(data.tokenMeasurement)).toMatchObject({
    input: 2,
    output: 1,
  });
  expect(result.stopCause).toBe("protocol");
});
it("persists pending before a simulated crash and blocks all new execution after restart", async () => {
  const dir = await home();
  const writer = await acquireHomeWriter(dir);
  try {
    expect(
      await new FileIntentLedger(dir, "session").claim(scope, action),
    ).toBe(true);
    const restarted = new FileIntentLedger(dir, "session");
    await expect(restarted.assertSettled()).rejects.toMatchObject({
      code: "uncertain",
    });
    expect(await restarted.claim(scope, { ...action, id: "new-id" })).toBe(
      false,
    );
    const bytes = await readFile(
      join(dir, "connection-intents/session.json"),
      "utf8",
    );
    expect(bytes).not.toContain('"text"');
    expect(bytes).toContain('"pending"');
  } finally {
    await writer.release();
  }
});
it("serializes different ledger instances and never resets corrupt evidence", async () => {
  const dir = await home();
  const a = new FileIntentLedger(dir, "session"),
    b = new FileIntentLedger(dir, "session");
  expect(
    await Promise.all([a.claim(scope, action), b.claim(scope, action)]),
  ).toEqual([true, false]);
  await a.complete(scope, action);
  expect(await new FileIntentLedger(dir, "session").claim(scope, action)).toBe(
    false,
  );
  await writeFile(join(dir, "connection-intents/session.json"), "torn-write");
  await expect(b.claim(scope, { ...action, id: "two" })).rejects.toMatchObject({
    code: "uncertain",
  });
  expect(
    await readFile(join(dir, "connection-intents/session.json"), "utf8"),
  ).toBe("torn-write");
});
it("connects A to the existing gate, action, tool-result next input and receipts", async () => {
  const execute = vi.fn(async () => ({ content: "OK" }));
  const opts = options(execute);
  const permission = vi.fn(async () => true);
  opts.permission = permission;
  let count = 0;
  const prompts: string[] = [];
  const sdk: SdkBinding = {
    subscriptionUseConfirmed: true,
    createXServer: (h) => h,
    async *query(request) {
      prompts.push(request.prompt);
      yield {
        type: "result",
        subtype: "success",
        usage,
        structured_output: { answer: "", actions: count++ ? [] : [action] },
      };
    },
  };
  const result = await runConnectedTurn(
    await home(),
    opts,
    { mode: "claude-proposals", taskId: "task", sdk, simulated: true },
    signal(),
  );
  expect(result.stopCause).toBe("end_turn");
  expect(execute).toHaveBeenCalledTimes(1);
  expect(permission).toHaveBeenCalledTimes(1);
  expect(prompts[1]).toContain("tool_result");
  expect(result.receipts.filter((r) => r.provider === "tool")).toHaveLength(1);
});
it("does not repeat side effects when SDK proposals are redelivered", async () => {
  const execute = vi.fn(async () => ({ content: "OK" }));
  const sdk: SdkBinding = {
    subscriptionUseConfirmed: true,
    createXServer: (h) => h,
    async *query() {
      yield {
        type: "result",
        subtype: "success",
        usage,
        structured_output: { answer: "", actions: [action] },
      };
    },
  };
  const result = await runConnectedTurn(
    await home(),
    options(execute),
    { mode: "claude-proposals", taskId: "task", sdk, simulated: true },
    signal(),
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result.stopCause).toBe("awaiting_user");
});
it("serializes a legitimate batch of X read tools without treating it as crash recovery", async () => {
  const execute = vi.fn(async () => ({ content: "OK" }));
  let round = 0;
  const sdk: SdkBinding = {
    subscriptionUseConfirmed: true,
    createXServer: (h) => h,
    async *query() {
      yield {
        type: "result",
        subtype: "success",
        usage,
        structured_output: {
          answer: "",
          actions: round++ ? [] : [action, { ...action, id: "two" }],
        },
      };
    },
  };
  const result = await runConnectedTurn(
    await home(),
    options(execute),
    { mode: "claude-proposals", taskId: "task", sdk, simulated: true },
    signal(),
  );
  expect(execute).toHaveBeenCalledTimes(2);
  expect(result.stopCause).toBe("end_turn");
});
it("B uses the same X gate and preserves tool history and receipts", async () => {
  const execute = vi.fn(async () => ({ content: "OK" }));
  const opts = options(execute);
  const receipt = vi.fn();
  opts.onEvent = receipt;
  const sdk: SdkBinding = {
    subscriptionUseConfirmed: true,
    createXServer: (h) => h,
    async *query({ options: settings }) {
      const h = settings.mcpServers.xharness as Record<
        string,
        (a: typeof action) => Promise<unknown>
      >;
      await h.Echo!(action);
      await h.Echo!(action);
      yield { type: "result", subtype: "success", result: "OK", usage };
    },
  };
  const result = await runConnectedTurn(
    await home(),
    opts,
    { mode: "claude-mcp", taskId: "task", sdk, simulated: true },
    signal(),
  );
  expect(execute).toHaveBeenCalledTimes(1);
  expect(
    result.messages
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result"),
  ).toHaveLength(1);
  expect(
    receipt.mock.calls.some(
      ([event]) =>
        event.type === "receipt" && event.receipt.provider === "tool",
    ),
  ).toBe(true);
});
it("stops pending recovery before SDK dispatch and respects the existing home writer", async () => {
  const dir = await home();
  await new FileIntentLedger(dir, "session").claim(scope, action);
  const query = vi.fn(async function* () {
    yield { type: "result" };
  });
  const sdk: SdkBinding = {
    subscriptionUseConfirmed: true,
    createXServer: (h) => h,
    query,
  };
  expect(
    (
      await runConnectedTurn(
        dir,
        options(),
        { mode: "claude-proposals", taskId: "task", sdk },
        signal(),
      )
    ).stopCause,
  ).toBe("protocol");
  expect(query).not.toHaveBeenCalled();
  const writer = await acquireHomeWriter(dir);
  try {
    await expect(
      runConnectedTurn(
        dir,
        options(),
        { mode: "claude-proposals", taskId: "task" },
        signal(),
      ),
    ).rejects.toThrow();
  } finally {
    await writer.release();
  }
});
it("development session saves X history/usage and refuses unconfigured modes", async () => {
  const dir = await home();
  const opts = options();
  const result = await runDevelopmentConnection(
    dir,
    process.cwd(),
    "Fixture",
    { mode: "openai-siwc" },
    opts,
    new AbortController(),
  );
  expect(result.stopCause).toBe("authentication");
  const sessions = new SessionStore(dir);
  await sessions.load();
  expect((await sessions.evaluationTask(result.sessionId))?.settled).toBe(true);
  expect(await sessions.messages(result.sessionId)).toHaveLength(1);
});
