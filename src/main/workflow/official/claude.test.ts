import { afterEach, expect, it, vi } from "vitest";
import { rm, symlink, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { OfficialSkillBundle } from "../../../shared/official-skills.js";
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
import { communicationInput } from "./communication.js";
import { publicEventRecorder } from "./public-events.js";
const homes: string[] = [];
it.each(["plan", "implement", "review"] as const)(
  "native %s does not inherit the fixture's eight-turn cap",
  async (phase) => {
    const mock = mockStart();
    const outcome = await new ClaudeWorkflowAgent(mock.start).run(
      { ...request(await cwd(), phase), nativeWork: true },
      new AbortController().signal,
    );
    expect(outcome.status).toBe("completed");
    expect(mock.options().maxTurns).toBeUndefined();
    expect(mock.accountInfo).toHaveBeenCalledTimes(1);
  },
);
it.each([
  ["error_max_turns", "claude-max-turns-exceeded"],
  ["error_max_budget_usd", "claude-sdk-budget-exceeded"],
  [
    "error_max_structured_output_retries",
    "claude-structured-output-retries-exceeded",
  ],
  ["error_during_execution", "claude-sdk-execution-failed"],
])(
  "preserves a fixed failure code from SDK result %s without raw errors or retries",
  async (subtype, code) => {
    const mock = mockStart(undefined, [
      {
        type: "result",
        subtype,
        is_error: true,
        errors: ["Bearer PRIVATE_TOKEN raw failure"],
      },
    ] as unknown as SDKMessage[]);
    const outcome = await new ClaudeWorkflowAgent(mock.start).run(
      request(await cwd()),
      new AbortController().signal,
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toBe(code);
    expect(outcome.diagnostics?.termination).toBe(subtype);
    expect(JSON.stringify(outcome)).not.toContain("PRIVATE_TOKEN");
    expect(mock.options().maxTurns).toBe(8);
    expect(mock.accountInfo).toHaveBeenCalledTimes(1);
  },
);
it.each(["allow", "deny", "cancel", "changed"])(
  "native tools explore beyond file hints and ask once for a command: %s",
  async (mode) => {
    const root = await cwd(),
      controller = new AbortController();
    const command: Record<string, unknown> = {
      command: "node --test; pnpm lint",
    };
    const approve = vi.fn(async () => {
      if (mode === "cancel") controller.abort();
      if (mode === "changed") command.command = "Get-Content .env";
      return mode !== "deny";
    });
    const behaviors: string[] = [];
    const mock = mockStart(async (options) => {
      expect(options.tools).toContain("Bash");
      const edit = await options.canUseTool!(
        "Write",
        { file_path: join(root, "new.ts") },
        {
          toolUseID: "new-file",
          requestId: "new-file",
          signal: controller.signal,
        },
      );
      behaviors.push(edit?.behavior ?? "missing");
      const notebook = await options.canUseTool!(
        "NotebookEdit",
        { notebook_path: join(root, "new.ipynb") },
        {
          toolUseID: "notebook",
          requestId: "notebook",
          signal: controller.signal,
        },
      );
      behaviors.push(notebook?.behavior ?? "missing");
      const result = await options.canUseTool!("Bash", command, {
        toolUseID: "cmd",
        requestId: "cmd",
        signal: controller.signal,
      });
      behaviors.push(result?.behavior ?? "missing");
    });
    const outcome = await new ClaudeWorkflowAgent(mock.start).run(
      {
        ...request(root),
        requestId: "11111111-1111-4111-8111-111111111111",
        nativeWork: true,
        approve,
      },
      controller.signal,
    );
    expect(approve).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(behaviors).toEqual([
        "allow",
        "allow",
        mode === "allow" ? "allow" : "deny",
      ]),
    );
    expect(outcome.status).toBe(
      mode === "allow"
        ? "completed"
        : mode === "cancel"
          ? "cancelled"
          : "failed",
    );
  },
);
it("records sanitized tool results from the SDK hook even when no user message is forwarded", async () => {
  const c = communicationInput({}),
    record = publicEventRecorder(c);
  const mock = mockStart(async (options) => {
    await options.hooks!.PostToolUse![0]!.hooks[0]!(
      {
        hook_event_name: "PostToolUse",
        session_id: "fixture",
        transcript_path: "unused",
        cwd: options.cwd!,
        tool_name: "Read",
        tool_use_id: "read-hook",
        tool_input: { file_path: "add.mjs" },
        tool_response: {
          text: "safe tool output",
          authorization: "private-auth",
        },
      } as HookInput,
      "read-hook",
      { signal: new AbortController().signal },
    );
  });
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    {
      ...request(await cwd()),
      event: async (e) => {
        record(e);
      },
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(c.events?.find((e) => e.kind === "tool_result")?.body?.text).toContain(
    "safe tool output",
  );
  expect(JSON.stringify(c)).not.toContain("private-auth");
});
it("persists the public response/tool/response sequence without thinking or account data", async () => {
  const values = [
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m1",
        model: "fixture-haiku",
        content: [
          { type: "thinking", thinking: "private-thought" },
          { type: "text", text: "Read next" },
          {
            type: "tool_use",
            id: "tool1",
            name: "Read",
            input: { file_path: "add.mjs" },
          },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool1",
            content: "return a - b",
          },
        ],
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m2",
        model: "fixture-haiku",
        content: [{ type: "text", text: "Final answer" }],
      },
    },
    {
      type: "result",
      subtype: "success",
      structured_output: { summary: "OK" },
      account_id: "private-account",
    },
  ] as unknown as SDKMessage[];
  const c = communicationInput({}),
    record = publicEventRecorder(c);
  const result = await new ClaudeWorkflowAgent(
    mockStart(undefined, values).start,
  ).run(
    {
      ...request(await cwd()),
      event: async (e) => {
        record(e);
      },
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(c.events?.map((e) => e.kind)).toEqual([
    "start",
    "response",
    "tool_request",
    "tool_result",
    "response",
    "end",
  ]);
  expect(JSON.stringify(c)).not.toContain("private-");
});
it("stops when public event persistence fails without replaying the SDK query", async () => {
  const mock = mockStart(),
    event = vi.fn(async () => {
      throw Error("fixture save failure");
    });
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    { ...request(await cwd()), event },
    new AbortController().signal,
  );
  expect(result.status).toBe("failed");
  expect(result.dispatched).toBe(false);
  expect(event).toHaveBeenCalledTimes(1);
});
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
it("records the managed SDK version separately from native model and CLI observations", async () => {
  const mock = mockStart();
  const result = await new ClaudeWorkflowAgent(mock.start, "0.3.291").run(
    request(await cwd()),
    new AbortController().signal,
  );
  expect(result.diagnostics?.sdkVersion).toBe("0.3.291");
  expect(result.diagnostics?.cliVersion).toBeUndefined();
});
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
it("conversation provides no tools and denies a forged write hook", async () => {
  const root = await cwd(),
    mock = mockStart(async (options) => {
      expect(options.tools).toEqual([]);
      expect(options.permissionMode).toBe("plan");
      const response = await pre(
        options,
        "Write",
        { file_path: join(root, "add.mjs"), content: "changed" },
        "forged",
      );
      expect(response).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    });
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    request(root, "conversation"),
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
});

function selectedSkill(): OfficialSkillBundle {
  const hash = (body: string) =>
    createHash("sha256").update(body).digest("hex");
  const body =
    "---\nname: sample\ndescription: Local selected skill\n---\nRead reference.txt.";
  const files = [
    { relativePath: "SKILL.md", body, hash: hash(body) },
    {
      relativePath: "reference.txt",
      body: "Local text reference",
      hash: hash("Local text reference"),
    },
  ];
  return {
    provider: "claude",
    scope: "project",
    name: "sample",
    source: "/selected/.claude/skills/sample/SKILL.md",
    hash: hash(body),
    bundleHash: hash(
      JSON.stringify(
        files.map(({ relativePath, hash }) => ({ relativePath, hash })),
      ),
    ),
    files,
  };
}
it.each(["plan", "implement", "review", "fix"] as const)(
  "isolates selected skills in native %s without assuming use from init",
  async (phase) => {
    const selected = selectedSkill();
    const mock = mockStart(undefined, [
      { type: "system", subtype: "init", skills: ["sample", "unselected"] },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: { summary: "OK" },
      },
    ] as unknown as SDKMessage[]);
    const result = await new ClaudeWorkflowAgent(mock.start).run(
      {
        ...request(await cwd(), phase),
        nativeWork: true,
        officialSkills: [selected],
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(mock.options().settingSources).toEqual([]);
    expect(mock.options().mcpServers).toEqual({});
    expect(mock.options().strictMcpConfig).toBe(true);
    expect(mock.options().tools).toContain("Skill");
    expect(mock.options().skills).toEqual(["xharness-selected-0:sample"]);
    expect(mock.options().plugins).toHaveLength(1);
    expect(result.officialSkillsEvidence).toEqual({
      requested: [
        {
          provider: selected.provider,
          scope: selected.scope,
          name: selected.name,
          source: selected.source,
          hash: selected.hash,
          bundleHash: selected.bundleHash,
        },
      ],
      dispatched: [{ name: "sample", mechanism: "claude-plugin" }],
      observed: [],
    });
    expect(JSON.stringify(result.officialSkillsEvidence)).not.toContain(
      selected.files[0]!.body,
    );
    expect(
      await stat(mock.options().plugins![0]!.path).catch(() => undefined),
    ).toBeUndefined();
  },
);
it.each([false, true])(
  "rejects selected skills before SDK creation for incompatible route %s",
  async (nativeWork) => {
    const mock = mockStart();
    const result = await new ClaudeWorkflowAgent(mock.start).run(
      {
        ...request(await cwd(), nativeWork ? "conversation" : "plan"),
        nativeWork,
        officialSkills: [selectedSkill()],
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toBe("official-skills-phase-unsupported");
    expect(result.dispatched).toBe(false);
    expect(mock.accountInfo).not.toHaveBeenCalled();
  },
);
it("records only real selected Skill calls and gates staged references in read-only planning", async () => {
  const privateBody = selectedSkill().files[0]!.body,
    privateReference = "LOCAL_SKILL_REFERENCE_PRIVATE",
    publicProject = "Ordinary project tool output";
  const events: unknown[] = [];
  const values: SDKMessage[] = [];
  const mock = mockStart(async (options) => {
    const input = { skill: "xharness-selected-0:sample" };
    const decision = await pre(options, "Skill", input, "skill-call");
    expect(
      "hookSpecificOutput" in decision
        ? decision.hookSpecificOutput
        : undefined,
    ).toMatchObject({
      permissionDecision: "allow",
    });
    // SDK canUseTool and hook may see the same call; evidence must not double count.
    expect(
      (
        await options.canUseTool!("Skill", input, {
          toolUseID: "skill-call",
          requestId: "skill-call",
          signal: new AbortController().signal,
        })
      )?.behavior,
    ).toBe("allow");
    const reference = join(
      options.plugins![0]!.path,
      "skills/sample/reference.txt",
    );
    expect(
      (
        await options.canUseTool!(
          "Read",
          { file_path: reference },
          {
            toolUseID: "read-ref",
            requestId: "read-ref",
            signal: new AbortController().signal,
          },
        )
      )?.behavior,
    ).toBe("allow");
    const hook = options.hooks!.PostToolUse![0]!.hooks[0]!;
    await hook(
      {
        hook_event_name: "PostToolUse",
        session_id: "fixture",
        transcript_path: "unused",
        cwd: options.cwd!,
        tool_name: "Skill",
        tool_input: input,
        tool_use_id: "skill-call",
        tool_response: privateBody,
      } as HookInput,
      "skill-call",
      { signal: new AbortController().signal },
    );
    await hook(
      {
        hook_event_name: "PostToolUse",
        session_id: "fixture",
        transcript_path: "unused",
        cwd: options.cwd!,
        tool_name: "Read",
        tool_input: { file_path: reference },
        tool_use_id: "read-ref",
        tool_response: privateReference,
      } as HookInput,
      "read-ref",
      { signal: new AbortController().signal },
    );
    values.push(
      ...([
        {
          type: "assistant",
          message: {
            id: "m1",
            model: "fixture-haiku",
            content: [
              { type: "tool_use", id: "skill-call", name: "Skill", input },
              {
                type: "tool_use",
                id: "read-ref",
                name: "Read",
                input: { file_path: reference },
              },
              {
                type: "tool_use",
                id: "project-read",
                name: "Read",
                input: { file_path: join(options.cwd!, "add.mjs") },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "skill-call",
                content: privateBody,
              },
              {
                type: "tool_result",
                tool_use_id: "read-ref",
                content: privateReference,
              },
              {
                type: "tool_result",
                tool_use_id: "project-read",
                content: publicProject,
              },
            ],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { summary: "OK" },
        },
      ] as unknown as SDKMessage[]),
    );
  }, values);
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    {
      ...request(await cwd(), "plan"),
      nativeWork: true,
      officialSkills: [selectedSkill()],
      event: async (event) => {
        events.push(event);
      },
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(result.officialSkillsEvidence?.observed).toEqual([
    { name: "sample", status: "requested" },
    { name: "sample", status: "allowed" },
    { name: "sample", status: "completed" },
  ]);
  expect(JSON.stringify({ events, result })).not.toContain(
    "Local selected skill",
  );
  expect(JSON.stringify({ events, result })).not.toContain(privateReference);
  expect(JSON.stringify(events)).toContain(publicProject);
});
it.each(["unselected", "staged-write", "source-read", "skill-extra"])(
  "denies unsupported skill access %s and cleans the snapshot",
  async (mode) => {
    const mock = mockStart(async (options) => {
      const name =
        mode === "staged-write"
          ? "Write"
          : mode === "source-read"
            ? "Read"
            : "Skill";
      const input =
        mode === "staged-write"
          ? {
              file_path: join(
                options.plugins![0]!.path,
                "skills/sample/reference.txt",
              ),
              content: "changed",
            }
          : mode === "source-read"
            ? { file_path: selectedSkill().source }
            : mode === "skill-extra"
              ? { skill: "xharness-selected-0:sample", command: "BAD" }
              : { skill: "unselected" };
      const decision = await pre(options, name, input, "denied");
      expect(
        "hookSpecificOutput" in decision
          ? decision.hookSpecificOutput
          : undefined,
      ).toMatchObject({ permissionDecision: "deny" });
    });
    const result = await new ClaudeWorkflowAgent(mock.start).run(
      {
        ...request(await cwd()),
        nativeWork: true,
        officialSkills: [selectedSkill()],
      },
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.officialSkillsEvidence?.observed).toEqual(
      mode === "skill-extra"
        ? [
            { name: "sample", status: "requested" },
            { name: "sample", status: "denied" },
          ]
        : [],
    );
    expect(
      await stat(mock.options().plugins![0]!.path).catch(() => undefined),
    ).toBeUndefined();
  },
);
it("rejects unsafe selected skill bodies before starting SDK", async () => {
  const selected = selectedSkill();
  selected.files[0]!.body += "!`BAD`";
  const mock = mockStart();
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    {
      ...request(await cwd(), "plan"),
      nativeWork: true,
      officialSkills: [selected],
    },
    new AbortController().signal,
  );
  expect(result.error).toBe("official-skill-stage-unsupported");
  expect(result.dispatched).toBe(false);
  expect(mock.accountInfo).not.toHaveBeenCalled();
});

it("cleans selected snapshots after cancellation without completion evidence", async () => {
  const controller = new AbortController();
  const mock = mockStart(async () => {
    controller.abort();
  });
  const result = await new ClaudeWorkflowAgent(mock.start).run(
    {
      ...request(await cwd(), "plan"),
      nativeWork: true,
      officialSkills: [selectedSkill()],
    },
    controller.signal,
  );
  expect(result.status).toBe("cancelled");
  expect(result.officialSkillsEvidence?.observed).toEqual([]);
  expect(
    await stat(mock.options().plugins![0]!.path).catch(() => undefined),
  ).toBeUndefined();
});

it.each(["add.mjs", "other.mjs"])(
  "DAG Claude direct write scope %s",
  async (file) => {
    const root = await cwd();
    let behavior: string | undefined;
    const mock = mockStart(async (options) => {
      const result = await options.canUseTool!(
        "Write",
        { file_path: join(root, file) },
        {
          toolUseID: "dag-edit",
          requestId: "dag-edit",
          signal: new AbortController().signal,
        },
      );
      behavior = result?.behavior;
    });
    await new ClaudeWorkflowAgent(mock.start).run(
      { ...request(root), nativeWork: true, writeScope: ["add.mjs"] },
      new AbortController().signal,
    );
    expect(behavior).toBe(file === "add.mjs" ? "allow" : "deny");
  },
);
it("invalid DAG Claude scope starts no SDK query", async () => {
  const start = vi.fn();
  const result = await new ClaudeWorkflowAgent(start).run(
    { ...request(await cwd()), nativeWork: true, writeScope: ["../outside"] },
    new AbortController().signal,
  );
  expect(result.dispatched).toBe(false);
  expect(start).not.toHaveBeenCalled();
});
