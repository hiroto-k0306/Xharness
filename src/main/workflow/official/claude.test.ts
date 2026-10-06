import { afterEach, expect, it, vi } from "vitest";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type {
  Options,
  SDKMessage,
  SDKControlGetUsageResponse,
  SDKUserMessage,
  HookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeWorkflowAgent, type ClaudeStart } from "./claude.js";
import {
  createSyntheticWorkspace,
  fixtureModels,
  fixtureTest,
} from "./fixtures.js";
import { schemas, type AgentRequest } from "./contracts.js";
import { sdkUsage } from "./usage.js";
import { normalizeTokens } from "../../providers/token-usage.js";
const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
});
const cwd = async () => {
  const home = await createSyntheticWorkspace("xh-sdk-workflow-");
  homes.push(home);
  return home;
};
const usage = {
  subscription_type: "pro",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 10, resets_at: "2026-10-06T20:00:00Z" },
    seven_day: { utilization: 20, resets_at: null },
    extra_usage: { is_enabled: false },
  },
} as SDKControlGetUsageResponse;
const request = (
  root: string,
  phase: AgentRequest["phase"] = "implement",
): AgentRequest => ({
  requestId: "fixture-request",
  taskId: "fixture-task",
  cwd: root,
  phase,
  model: fixtureModels[1]!,
  effort: null,
  prompt: "Fixture only",
  files: ["add.mjs"],
  tests: [fixtureTest()],
  outputSchema: schemas.implement,
  timeoutMs: 1000,
  tool: vi.fn(async () => {}),
  approve: vi.fn(async () => false),
});
function mockStart(
  callback?: (options: Options) => Promise<void>,
  values: SDKMessage[] = [
    {
      type: "result",
      subtype: "success",
      is_error: false,
      structured_output: { summary: "OK" },
      modelUsage: {
        "fixture-haiku": {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 1,
        },
      },
    } as unknown as SDKMessage,
  ],
) {
  let captured: Options,
    input: AsyncIterable<SDKUserMessage>,
    released = false;
  const close = vi.fn(),
    accountInfo = vi.fn(async () => {
      expect(released).toBe(false);
      return { apiProvider: "firstParty" as const, subscriptionType: "pro" };
    });
  const start: ClaudeStart = (r) => {
    captured = r.options;
    input = r.prompt;
    return {
      close,
      accountInfo,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: vi.fn(
        async () => usage,
      ),
      supportedModels: async () => [
        {
          value: "fixture-opus",
          resolvedModel: "fixture-opus",
          displayName: "fixture",
          description: "mock",
          supportedEffortLevels: ["high"],
        },
      ],
      async *[Symbol.asyncIterator]() {
        const next = await input[Symbol.asyncIterator]().next();
        released = !next.done;
        if (callback) await callback(captured);
        yield* values;
      },
    };
  };
  return { start, close, accountInfo, options: () => captured! };
}
async function pre(
  options: Options,
  name: string,
  input: Record<string, unknown>,
  id: string,
) {
  const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
  return hook(
    {
      hook_event_name: "PreToolUse",
      session_id: "fixture",
      transcript_path: "unused",
      cwd: options.cwd!,
      tool_name: name,
      tool_input: input,
      tool_use_id: id,
    } as HookInput,
    id,
    { signal: new AbortController().signal },
  );
}
it("stops the native loop when durable tool evidence cannot be recorded", async () => {
  const root = await cwd(),
    req = request(root);
  req.tool = async () => {
    throw new Error("fixture storage unavailable");
  };
  const mock = mockStart(async (options) => {
    await pre(
      options,
      "Write",
      { file_path: join(root, "add.mjs"), content: "x" },
      "write-fail",
    );
  });
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    req,
    new AbortController().signal,
  );
  expect(result.status).toBe("failed");
  expect(mock.close).toHaveBeenCalled();
});
it("keeps auth and quota verification ahead of model input and returns official available models", async () => {
  const root = await cwd(),
    mock = mockStart(),
    agent = new ClaudeWorkflowAgent(mock.start);
  const models = await agent.discover(root, new AbortController().signal);
  expect(models[0]).toMatchObject({
    model: "fixture-opus",
    efforts: [null, "high"],
    quotaAllowed: true,
    capabilitySource: "official-sdk",
  });
  expect(mock.accountInfo).toHaveBeenCalledTimes(1);
  expect(mock.close).toHaveBeenCalled();
});
it.each(["plan", "review"] as const)(
  "%s never grants native write/shell/delegation or credential access",
  async (phase) => {
    const root = await cwd(),
      mock = mockStart(async (options) => {
        for (const [name, input] of [
          ["Write", { file_path: join(root, "add.mjs"), content: "x" }],
          ["Bash", { command: fixtureTest().command }],
          ["Agent", {}],
          ["Read", { file_path: join(root, ".codex/auth.json") }],
        ] as const) {
          expect(await pre(options, name, input, name)).toMatchObject({
            hookSpecificOutput: { permissionDecision: "deny" },
          });
        }
        expect(
          await pre(
            options,
            "Read",
            { file_path: join(root, "add.mjs") },
            "read-code",
          ),
        ).toMatchObject({
          hookSpecificOutput: { permissionDecision: "allow" },
        });
      });
    await new ClaudeWorkflowAgent(mock.start).run(
      request(root, phase),
      new AbortController().signal,
    );
    expect(mock.options()).toMatchObject({
      tools: ["Read", "Glob", "Grep"],
      permissionMode: "plan",
      persistSession: false,
      settingSources: [],
      skills: [],
      plugins: [],
      strictMcpConfig: true,
    });
  },
);
it("preserves native implementation tools but bounds files, commands and duplicate action IDs", async () => {
  const root = await cwd(),
    req = request(root),
    mock = mockStart(async (options) => {
      expect(
        await pre(
          options,
          "Write",
          { file_path: join(root, "add.mjs"), content: "code" },
          "write-one",
        ),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
      expect(
        await pre(
          options,
          "Write",
          { file_path: join(root, "other.mjs"), content: "code" },
          "outside-scope",
        ),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(
        await pre(
          options,
          "Bash",
          { command: fixtureTest().command },
          "test-one",
        ),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: "allow" } });
      expect(
        await pre(
          options,
          "Bash",
          { command: "node --test; read credentials" },
          "bad-command",
        ),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
      expect(
        await pre(
          options,
          "Write",
          { file_path: join(root, "add.mjs"), content: "different" },
          "write-one",
        ),
      ).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    });
  vi.stubEnv("ANTHROPIC_API_KEY", "fixture-secret");
  vi.stubEnv("NODE_OPTIONS", "fixture-secret");
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    req,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(result.usage?.scope).toBe("query-pipeline");
  expect(mock.options().tools).toEqual([
    "Read",
    "Glob",
    "Grep",
    "Edit",
    "Write",
    "Bash",
  ]);
  expect(mock.options().env?.ANTHROPIC_API_KEY).toBeUndefined();
  expect(mock.options().env?.NODE_OPTIONS).toBeUndefined();
  expect(req.tool).toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(req.tool).mock.calls)).not.toContain(
    "fixture-secret",
  );
});
it("denies cross-worktree paths, junction escapes, child/background shell and hidden MCP tools before execution", async () => {
  const root = await cwd(),
    outside = await cwd();
  await symlink(outside, join(root, "escape"), "junction");
  const mock = mockStart(async (options) => {
    const denied = [
      ["Write", { file_path: join(outside, "add.mjs"), content: "blocked" }],
      [
        "Write",
        { file_path: join(root, "escape/add.mjs"), content: "blocked" },
      ],
      ["Write", { file_path: "../add.mjs", content: "blocked" }],
      ["Bash", { command: fixtureTest().command, run_in_background: true }],
      ["Bash", { command: fixtureTest().command + " && node child.mjs" }],
      ["mcp__hidden__write", {}],
      ["Agent", {}],
    ] as const;
    for (const [index, [name, input]] of denied.entries())
      expect(await pre(options, name, input, `deny-${index}`)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
  });
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    request(root),
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
});
it("cancels uncooperative SDK iteration and never retries or falls back", async () => {
  const root = await cwd(),
    mock = mockStart(async () => {
      await new Promise(() => {});
    });
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    { ...request(root), timeoutMs: 15 },
    new AbortController().signal,
  );
  expect(result.status).toBe("timeout");
  expect(mock.accountInfo).toHaveBeenCalledTimes(1);
  expect(mock.close).toHaveBeenCalled();
  expect(result.usage).toBeNull();
});
it("prefers whole query model totals once and keeps unknown thinking/cache components unknown", () => {
  const measured = sdkUsage({
    modelUsage: {
      main: {
        inputTokens: 10,
        outputTokens: 3,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        thinkingTokens: 2,
      },
      child: {
        inputTokens: 4,
        outputTokens: 1,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
    usage: { input_tokens: 999, output_tokens: 999 },
  })!;
  expect(normalizeTokens(measured.measurement)).toMatchObject({
    input: 17,
    output: 4,
    reasoning: null,
    total: 21,
  });
  expect(measured.byModel).toHaveLength(2);
  expect(
    sdkUsage({ modelUsage: { main: { inputTokens: 10 } } })?.complete,
  ).toBe(false);
  expect(
    sdkUsage({
      subtype: "success",
      is_error: true,
      usage: { input_tokens: 0, output_tokens: 0 },
    }),
  ).toBeNull();
});
