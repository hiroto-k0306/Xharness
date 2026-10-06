import { describe, expect, it, vi } from "vitest";
import { MemoryIntentLedger, RunBoundary, ToolGateway } from "./boundary.js";
import { validateProposal, type Input } from "./contracts.js";
import {
  ClaudeMcpDelegation,
  ClaudeProposals,
  sdkReadiness,
  type SdkBinding,
  type SdkOptions,
} from "./claude.js";
import { SiwcInference, siwcReadiness, type SiwcBinding } from "./openai.js";
import { measure } from "./measurement.js";

const input: Input = {
  taskId: "task",
  sessionId: "session",
  requestId: "request",
  model: "synthetic",
  instructions: "Synthetic fixed task",
  history: [{ role: "user", content: "Return OK" }],
  tools: [],
  timeoutMs: 1000,
};
const scope = {
  taskId: input.taskId,
  sessionId: input.sessionId,
  requestId: input.requestId,
};
const signal = () => new AbortController().signal;
const action = { id: "one", tool: "echo", input: { text: "OK" } };
const usage = {
  input_tokens: 12,
  output_tokens: 4,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 2,
};
function sdk(events: unknown[]): SdkBinding {
  return {
    subscriptionUseConfirmed: true,
    createXServer: (h) => h,
    async *query() {
      yield* events;
    },
  };
}
function siwc(events: unknown[]): SiwcBinding {
  return {
    registrationConfirmed: true,
    grantSource: "registered-client",
    async *send() {
      yield* events;
    },
  };
}
function gateway(
  execute = vi.fn(async () => "OK"),
  authorize = vi.fn(async () => true),
  ledger = new MemoryIntentLedger(),
) {
  return {
    execute,
    authorize,
    ledger,
    value: new ToolGateway(
      scope,
      {
        echo: {
          validate: (x) =>
            !!x &&
            typeof x === "object" &&
            (x as { text?: unknown }).text === "OK",
          execute,
        },
        auth_login: { validate: () => true, execute },
      },
      ledger,
      authorize,
    ),
  };
}
describe("X-owned connection boundaries", () => {
  it("snapshots X identity before awaiting transport", async () => {
    const mutable = structuredClone(input);
    let release: () => void = () => {};
    const binding = siwc([]);
    binding.send = async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield { type: "response.completed", response: { status: "completed" } };
    };
    const pending = new SiwcInference(binding).infer(mutable, signal());
    mutable.taskId = "other";
    mutable.sessionId = "other";
    release();
    expect(await pending).toMatchObject({
      taskId: "task",
      sessionId: "session",
      status: "completed",
    });
  });
  it("keeps observed usage when structured quality validation fails", async () => {
    const result = await new ClaudeProposals(
      sdk([
        { type: "result", subtype: "success", structured_output: {}, usage },
      ]),
    ).infer(input, signal());
    expect(result).toMatchObject({
      status: "failed",
      error: "malformed",
      measurement: { input: 17, output: 4 },
    });
  });
  it("preserves SDK failed-attempt usage and provider-native subset structure", async () => {
    const result = await new ClaudeProposals(
      sdk([{ type: "result", subtype: "error_max_turns", usage }]),
    ).infer(input, signal());
    expect(result).toMatchObject({
      status: "failed",
      measurement: { input: 17, output: 4 },
    });
    expect(
      measure("responses", {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 5 },
      })?.raw,
    ).toEqual({ input_tokens: 20, input_tokens_details: { cached_tokens: 5 } });
  });
  it("keeps all new modes unavailable without bindings", async () => {
    expect(siwcReadiness().available).toBe(false);
    expect(sdkReadiness().available).toBe(false);
    expect((await new SiwcInference().infer(input, signal())).error).toBe(
      "unconfigured",
    );
    expect((await new ClaudeProposals().infer(input, signal())).error).toBe(
      "unconfigured",
    );
    expect(
      (
        await new ClaudeMcpDelegation(undefined, gateway().value).delegate(
          input,
          signal(),
          () => {},
        )
      ).error,
    ).toBe("unconfigured");
  });
  it.each([
    null,
    {},
    { answer: "OK", actions: [{ ...action, tool: "Bash" }] },
    { answer: "OK", actions: [action, action] },
    { answer: "OK", actions: [], permissions: "bypass" },
  ])("rejects invalid proposals %j", (value) => {
    expect(() => validateProposal(value, ["echo"])).toThrow();
  });
  it("requires X authorization even for SDK preapproved tools", async () => {
    const g = gateway(
      undefined,
      vi.fn(async () => false),
    );
    await expect(
      g.value.execute(scope, action, signal()),
    ).rejects.toMatchObject({ code: "denied" });
    expect(g.execute).not.toHaveBeenCalled();
    expect(g.ledger.records.size).toBe(0);
  });
  it("validates arguments before permissions and blocks control changes", async () => {
    const g = gateway();
    await expect(
      g.value.execute(scope, { ...action, input: {} }, signal()),
    ).rejects.toMatchObject({ code: "malformed" });
    await expect(
      g.value.execute(scope, { ...action, tool: "auth_login" }, signal()),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(g.authorize).not.toHaveBeenCalled();
  });
  it("rejects another session or request", async () => {
    const g = gateway();
    await expect(
      g.value.execute({ ...scope, sessionId: "other" }, action, signal()),
    ).rejects.toMatchObject({ code: "session-mismatch" });
    await expect(
      g.value.execute({ ...scope, requestId: "other" }, action, signal()),
    ).rejects.toMatchObject({ code: "session-mismatch" });
    expect(g.execute).not.toHaveBeenCalled();
  });
  it("claims once under parallel duplicate execution and blocks restart replay", async () => {
    const g = gateway();
    const results = await Promise.allSettled([
      g.value.execute(scope, action, signal()),
      g.value.execute(scope, action, signal()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(g.execute).toHaveBeenCalledTimes(1);
    const restarted = gateway(
      g.execute,
      undefined,
      new MemoryIntentLedger(new Map(g.ledger.records)),
    );
    await expect(
      restarted.value.execute(scope, action, signal()),
    ).rejects.toMatchObject({ code: "uncertain" });
  });
  it("keeps failed and late-aborted side effects pending", async () => {
    const controller = new AbortController();
    const g = gateway(
      vi.fn(async () => {
        controller.abort();
        return "OK";
      }),
    );
    await expect(
      g.value.execute(scope, action, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect([...g.ledger.records.values()]).toEqual(["pending"]);
    await expect(
      g.value.execute(scope, action, signal()),
    ).rejects.toMatchObject({ code: "uncertain" });
  });
  it("does not begin execution after cancellation during authorization", async () => {
    const controller = new AbortController();
    const g = gateway(
      undefined,
      vi.fn(async () => {
        controller.abort();
        return true;
      }),
    );
    await expect(
      g.value.execute(scope, action, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(g.execute).not.toHaveBeenCalled();
  });
  it("times out an uncooperative transport and cancels its signal", async () => {
    let inner: AbortSignal | undefined;
    const boundary = new RunBoundary();
    const result = await boundary.run(
      "openai-siwc",
      { ...input, timeoutMs: 5 },
      signal(),
      (s) => {
        inner = s;
        return new Promise(() => {});
      },
    );
    expect(result.status).toBe("timeout");
    expect(inner?.aborted).toBe(true);
  });
  it("cancels without accepting a late transport result", async () => {
    const controller = new AbortController();
    let resolve: (v: object) => void = () => {};
    const boundary = new RunBoundary();
    const pending = boundary.run(
      "openai-siwc",
      input,
      controller.signal,
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    controller.abort();
    expect((await pending).status).toBe("cancelled");
    resolve({ status: "completed" });
    expect(
      (
        await boundary.run("openai-siwc", input, signal(), async () => ({
          status: "completed",
        }))
      ).error,
    ).toBe("duplicate");
  });
  it("does not reinterpret missing provider usage or cache subsets", () => {
    expect(measure("responses", undefined)).toBeNull();
    expect(
      measure("responses", {
        input_tokens: 20,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens_details: { reasoning_tokens: 3 },
      }),
    ).toMatchObject({ input: 20, output: 8 });
    expect(measure("sdk-result", usage)).toMatchObject({
      input: 17,
      output: 4,
    });
    expect(
      measure("sdk-result", { input_tokens: 12, output_tokens: 4 }),
    ).toMatchObject({ input: null, output: 4 });
    expect(
      measure("responses", {
        input_tokens: -1,
        output_tokens: NaN,
        token: "SECRET",
      }),
    ).toMatchObject({ raw: {}, input: null, output: null });
  });
  it("uses the public endpoint and complete history without unsupported fields", async () => {
    const binding = siwc([
      { type: "response.output_text.delta", delta: "OK" },
      {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      },
    ]);
    const send = vi.spyOn(binding, "send");
    expect(
      (await new SiwcInference(binding).infer(input, signal())).proposal
        ?.answer,
    ).toBe("OK");
    expect(send.mock.calls[0]?.[0]).toEqual({
      endpoint: "https://api.openai.com/v1/responses",
      body: {
        model: input.model,
        instructions: input.instructions,
        input: input.history,
        store: false,
        stream: true,
      },
    });
  });
  it.each([
    [[{ type: "response.output_text.delta", delta: "OK" }]],
    [[{ type: "response.incomplete" }]],
    [[{ type: "response.completed", response: { status: "failed" } }]],
  ])("does not treat partial output as success", async (events) => {
    expect(
      (await new SiwcInference(siwc(events)).infer(input, signal())).status,
    ).toBe("failed");
  });
  it("pauses quota until explicit acknowledgement with no fallback or guessed percent", async () => {
    const binding = siwc([
      {
        type: "response.failed",
        response: {
          error: { code: "subscription_sharing_usage_limit_exceeded" },
        },
      },
    ]);
    const send = vi.spyOn(binding, "send");
    const model = new SiwcInference(binding);
    const paused = await model.infer(input, signal());
    expect(paused).toMatchObject({
      status: "quota-paused",
      quota: { source: "official-response", usedPercent: null, resetAt: null },
    });
    expect(
      (await model.infer({ ...input, requestId: "two" }, signal())).status,
    ).toBe("quota-paused");
    expect(send).toHaveBeenCalledTimes(1);
    model.boundary.acknowledgeQuota(input.sessionId);
    await model.infer({ ...input, requestId: "three" }, signal());
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("validates OpenAI action JSON before X execution", async () => {
    const binding = siwc([
      {
        type: "response.output_text.delta",
        delta: JSON.stringify({ answer: "", actions: [action] }),
      },
      { type: "response.completed", response: { status: "completed" } },
    ]);
    expect(
      (
        await new SiwcInference(binding).infer(
          { ...input, tools: ["echo"] },
          signal(),
        )
      ).proposal?.actions,
    ).toEqual([action]);
  });
  it("A removes builtins/settings/MCP and returns proposals without executing", async () => {
    const binding = sdk([
      {
        type: "result",
        subtype: "success",
        structured_output: { answer: "", actions: [action] },
        usage,
      },
    ]);
    const query = vi.spyOn(binding, "query");
    const result = await new ClaudeProposals(binding).infer(
      { ...input, tools: ["echo"] },
      signal(),
    );
    expect(result.proposal?.actions).toEqual([action]);
    expect(query.mock.calls[0]?.[0].options).toMatchObject({
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      allowedTools: [],
      persistSession: false,
      permissionMode: "dontAsk",
    });
  });
  it.each([
    {},
    { type: "result", subtype: "success" },
    { type: "result", subtype: "error_max_turns" },
  ])("A rejects missing structured output", async (event) => {
    expect(
      (await new ClaudeProposals(sdk([event])).infer(input, signal())).status,
    ).toBe("failed");
  });
  it("rejects SDK session mixup", async () => {
    const events = [
      { type: "system", session_id: "one" },
      {
        type: "result",
        session_id: "two",
        subtype: "success",
        structured_output: { answer: "OK", actions: [] },
      },
    ];
    expect(
      (await new ClaudeProposals(sdk(events)).infer(input, signal())).error,
    ).toBe("session-mismatch");
  });
  it("B exposes only X handlers and enforces permissions independently of allowedTools", async () => {
    const g = gateway();
    let options: SdkOptions | undefined;
    const binding = sdk([]);
    binding.query = async function* (request) {
      options = request.options;
      const handlers = options.mcpServers.xharness as Record<
        string,
        (a: typeof action) => Promise<unknown>
      >;
      expect(await handlers.echo!(action)).toEqual({
        content: [{ type: "text", text: "OK" }],
      });
      expect(await handlers.echo!(action)).toMatchObject({ isError: true });
      yield { type: "result", subtype: "success", result: "OK", usage };
    };
    const phases: string[] = [];
    const result = await new ClaudeMcpDelegation(binding, g.value).delegate(
      { ...input, tools: ["echo"] },
      signal(),
      (p) => phases.push(p),
    );
    expect(result.status).toBe("failed");
    expect(g.execute).toHaveBeenCalledTimes(1);
    expect(g.authorize).toHaveBeenCalled();
    expect(options?.allowedTools).toEqual(["mcp__xharness__echo"]);
    expect(await options?.canUseTool("Bash")).toMatchObject({
      behavior: "deny",
    });
    const hook = options!.hooks.PreToolUse[0]!.hooks[0]!;
    expect(await hook({ tool_name: "Bash" })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(phases).toEqual(["started", "tool", "tool", "finished"]);
  });
});
