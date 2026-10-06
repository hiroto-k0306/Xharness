import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CodexWorkflowAgent, codexQuota } from "./codex.js";
import type { AppServerPort } from "./app-server-rpc.js";
import { fixtureModels, fixtureTest } from "./fixtures.js";
import { schemas, type AgentRequest } from "./contracts.js";
import { normalizeTokens } from "../../providers/token-usage.js";
import { object } from "./usage.js";
function fakeServer(quotaOverride: Record<string, unknown> = {}) {
  let listener:
    ((method: string, params: Record<string, unknown>) => void) | undefined;
  let approval:
    | ((method: string, params: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  const calls: [string, Record<string, unknown>][] = [],
    close = vi.fn();
  const quota = {
    ordinaryUsageAllowed: true,
    rateLimits: {
      credits: { hasCredits: false, unlimited: false },
      primary: { usedPercent: 10, resetsAt: 1791300000 },
    },
    ...quotaOverride,
  };
  const server: AppServerPort = {
    close,
    notify: vi.fn(),
    approve: (h) => {
      approval = h;
    },
    subscribe: (h) => {
      listener = h;
      return () => {
        listener = undefined;
      };
    },
    async request(method, raw) {
      const params = object(raw);
      calls.push([method, params]);
      if (method === "initialize") return {};
      if (method === "account/read")
        return {
          account: {
            type: "chatgpt",
            planType: "prolite",
            email: "never-persist@example.invalid",
          },
        };
      if (method === "account/rateLimits/read") return quota;
      if (method === "config/read")
        return {
          config: {
            chatgpt_base_url: "https://chatgpt.com/backend-api/",
            mcp_servers: { outside: { token: "never-persist-token" } },
          },
        };
      if (method === "model/list")
        return {
          data: [
            {
              model: "fixture-codex",
              hidden: false,
              supportedReasoningEfforts: [{ reasoningEffort: "low" }],
            },
          ],
          nextCursor: null,
        };
      if (method === "thread/start")
        return {
          thread: { id: "thread-fixture" },
          model: params.model,
          modelProvider: "openai",
          serviceTier: "default",
        };
      if (method === "turn/start") {
        queueMicrotask(() => {
          listener?.("turn/started", {
            threadId: "thread-fixture",
            turn: { id: "turn-fixture" },
          });
          for (let i = 0; i < 2; i++)
            listener?.("thread/tokenUsage/updated", {
              threadId: "thread-fixture",
              turnId: "turn-fixture",
              tokenUsage: {
                total: {
                  inputTokens: 20,
                  outputTokens: 8,
                  cachedInputTokens: 10,
                  reasoningOutputTokens: 4,
                  totalTokens: 28,
                },
              },
            });
          const item = {
            id: "answer-fixture",
            type: "agentMessage",
            phase: "final_answer",
            text: JSON.stringify({ summary: "OK" }),
          };
          listener?.("item/completed", {
            threadId: "thread-fixture",
            turnId: "turn-fixture",
            item,
          });
          listener?.("turn/completed", {
            threadId: "thread-fixture",
            turn: { id: "turn-fixture", status: "completed", items: [item] },
          });
        });
        return { turn: { id: "turn-fixture" } };
      }
      throw new Error("Unknown fixture method");
    },
  };
  return {
    server,
    calls,
    close,
    approval: () => approval!,
    emit: (method: string, params: Record<string, unknown>) =>
      listener?.(method, params),
  };
}
const request = (phase: AgentRequest["phase"] = "review"): AgentRequest => ({
  requestId: "request-fixture",
  taskId: "task-fixture",
  phase,
  cwd: process.cwd(),
  model: fixtureModels[2]!,
  effort: "low",
  prompt: "Synthetic only",
  files: ["add.mjs"],
  tests: [fixtureTest()],
  outputSchema: schemas.implement,
  timeoutMs: 1000,
  tool: vi.fn(async () => {}),
  approve: vi.fn(async () => false),
});
it("uses official account/model APIs and does not copy or retain auth/account/config values", async () => {
  const mock = fakeServer(),
    agent = new CodexWorkflowAgent(() => mock.server);
  const models = await agent.discover(
    process.cwd(),
    new AbortController().signal,
  );
  expect(models[0]).toMatchObject({
    model: "fixture-codex",
    efforts: [null, "low"],
    quotaAllowed: true,
  });
  expect(mock.calls.map(([m]) => m)).toEqual([
    "initialize",
    "account/read",
    "account/rateLimits/read",
    "model/list",
  ]);
  expect(JSON.stringify(models)).not.toMatch(/never-persist/);
  expect(mock.close).toHaveBeenCalled();
});
it.each(["review", "implement", "conversation"] as const)(
  "runs %s with a fresh native thread, structured output and cumulative usage once",
  async (phase) => {
    const mock = fakeServer(),
      agent = new CodexWorkflowAgent(() => mock.server);
    const result = await agent.run(
      { ...request(phase), diagnosticText: true },
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(result.diagnostics).toMatchObject({
      requestId: "request-fixture",
      phase,
      requestedModel: "fixture-codex",
      finalAnswer: '{"summary":"OK"}',
      termination: "completed",
    });
    expect(result.nativeSessionId).toBe("thread-fixture");
    expect(result.nativeTurnId).toBe("turn-fixture");
    expect(normalizeTokens(result.usage!.measurement)).toMatchObject({
      input: 20,
      output: 8,
      cacheRead: 10,
      reasoning: 4,
      total: 28,
    });
    const started = mock.calls.find(([m]) => m === "thread/start")![1];
    expect(started).toMatchObject({
      ephemeral: true,
      modelProvider: "openai",
      allowProviderModelFallback: false,
      serviceTier: "default",
      environments: [],
      sandbox: phase !== "implement" ? "read-only" : "workspace-write",
    });
    expect(started.config).toMatchObject({
      "features.multi_agent": false,
      "features.hooks": false,
      "features.plugins": false,
      "mcp_servers.outside.enabled": false,
      forced_login_method: "chatgpt",
      service_tier: "default",
    });
    const turn = mock.calls.find(([m]) => m === "turn/start")![1];
    expect(turn.outputSchema).toEqual(schemas.implement);
    expect(turn.summary).toBe("none");
    expect(turn.serviceTierForTurn).toBe("default");
    expect(turn.sandboxPolicy).toEqual(
      phase !== "implement"
        ? { type: "readOnly", networkAccess: false }
        : {
            type: "workspaceWrite",
            writableRoots: [request(phase).cwd],
            networkAccess: false,
            excludeSlashTmp: true,
            excludeTmpdirEnvVar: true,
          },
    );
    expect(JSON.stringify(result)).not.toMatch(/never-persist/);
    expect(mock.close).toHaveBeenCalled();
  },
);
it.each([
  { ordinaryUsageAllowed: null },
  { ordinaryUsageAllowed: false },
  { ordinaryUsageAllowed: undefined },
  { rateLimits: { primary: { usedPercent: 100 } } },
  { rateLimits: { spendControlReached: true } },
])(
  "does not dispatch a turn when included usage or billing conditions are uncertain",
  async (quota) => {
    const mock = fakeServer(quota),
      result = await new CodexWorkflowAgent(() => mock.server).run(
        request(),
        new AbortController().signal,
      );
    expect(result).toMatchObject({
      status: "quota-paused",
      dispatched: false,
      usage: null,
    });
    expect(
      mock.calls.some(([m]) => m === "thread/start" || m === "turn/start"),
    ).toBe(false);
  },
);
it("never interprets a reset time or low utilization as authoritative recovery", () => {
  expect(
    codexQuota({
      rateLimits: {
        credits: { hasCredits: false, unlimited: false },
        primary: { usedPercent: 0, resetsAt: 1 },
      },
    }).allowed,
  ).toBeNull();
});
it("stops immediately on an explicit in-flight limit", async () => {
  const mock = fakeServer();
  const subscribe = mock.server.subscribe;
  mock.server.subscribe = (listener) =>
    subscribe((method, params) => {
      if (method === "turn/started")
        listener("account/rateLimits/updated", {
          rateLimits: { primary: { usedPercent: 100 } },
        });
      listener(method, params);
    });
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    request(),
    new AbortController().signal,
  );
  expect(result.status).toBe("quota-paused");
  expect(result.dispatched).toBe(true);
  expect(result.error).toContain("通常利用枠の制限");
  expect(mock.close).toHaveBeenCalled();
});
const observedRead = JSON.parse(
  readFileSync(
    new URL(
      "../../../../test/fixtures/codex/official-rate-limits-read.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
it.each(["approval", "completion"] as const)(
  "rechecks quota arriving during %s evidence persistence before returning",
  async (boundary) => {
    const mock = fakeServer(observedRead),
      original = mock.server.request;
    let reads = 0,
      release!: (value: unknown) => void,
      settled = false;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    mock.server.request = async (method, params, signal) => {
      if (method === "account/rateLimits/read" && ++reads === 2) return pending;
      if (method === "turn/start") {
        if (boundary === "approval") {
          await expect(
            mock.approval()("item/commandExecution/requestApproval", {
              threadId: "thread-fixture",
              cwd: process.cwd(),
              command: fixtureTest().command,
            }),
          ).rejects.toThrow();
        } else {
          mock.emit("item/completed", {
            threadId: "thread-fixture",
            item: {
              id: "command",
              type: "commandExecution",
              status: "completed",
            },
          });
        }
      }
      return original(method, params, signal);
    };
    const req = request("implement");
    req.tool = async () => {
      // Model completion can arrive while its evidence is still being saved.
      await new Promise((resolve) => setTimeout(resolve, 5));
      mock.emit("account/rateLimits/updated", { rateLimits: {} });
    };
    const running = new CodexWorkflowAgent(() => mock.server)
      .run(req, new AbortController().signal)
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(settled).toBe(false);
    release({ ...observedRead, ordinaryUsageAllowed: false });
    expect((await running).status).toBe("quota-paused");
  },
);
it("verifies account/read after the initial account announcement without treating it as a change", async () => {
  const mock = fakeServer(),
    original = mock.server.request;
  mock.server.request = async (method, params, signal) => {
    if (method === "initialize")
      mock.emit("account/updated", { authMode: "chatgpt", planType: null });
    return original(method, params, signal);
  };
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    request(),
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(mock.calls.some(([m]) => m === "account/read")).toBe(true);
});
it.each([
  null,
  { hasCredits: true, unlimited: false },
  { hasCredits: true, unlimited: true },
])(
  "does not mistake a credit balance for the active billing route: %j",
  async (credits) => {
    const mock = fakeServer({
      ...observedRead,
      rateLimits: { ...observedRead.rateLimits, credits },
    });
    const result = await new CodexWorkflowAgent(() => mock.server).run(
      request(),
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
  },
);
it.each(["success", "exhausted", "failure", "unknown"] as const)(
  "refetches a sparse notification once, and waits before accepting completion: %s",
  async (outcome) => {
    const mock = fakeServer(observedRead),
      original = mock.server.request;
    let reads = 0;
    mock.server.request = async (method, params, signal) => {
      if (method === "account/rateLimits/read" && ++reads === 2) {
        await new Promise((r) => setTimeout(r, 5));
        if (outcome === "failure")
          throw new Error("never-persist-server-detail");
        return {
          ...observedRead,
          ordinaryUsageAllowed:
            outcome === "success"
              ? true
              : outcome === "exhausted"
                ? false
                : null,
        };
      }
      return original(method, params, signal);
    };
    const subscribe = mock.server.subscribe;
    mock.server.subscribe = (listener) =>
      subscribe((method, params) => {
        if (method === "turn/started")
          for (let n = 0; n < 3; n++)
            listener("account/rateLimits/updated", {
              rateLimits: { primary: { usedPercent: 63 } },
            });
        listener(method, params);
      });
    const result = await new CodexWorkflowAgent(() => mock.server).run(
      request(),
      new AbortController().signal,
    );
    expect(reads).toBe(2);
    expect(result.status).toBe(
      outcome === "success" ? "completed" : "quota-paused",
    );
    if (outcome === "failure") expect(result.error).toContain("再取得に失敗");
    if (outcome === "unknown")
      expect(result.error).toContain("ordinaryUsageAllowed");
    expect(JSON.stringify(result)).not.toContain("never-persist");
  },
);
it("does not let a delayed quota read clear a newer explicit denial", async () => {
  const mock = fakeServer(observedRead),
    original = mock.server.request;
  let reads = 0;
  mock.server.request = async (method, params, signal) => {
    if (method === "account/rateLimits/read" && ++reads === 2) {
      await new Promise((r) => setTimeout(r, 5));
      return observedRead;
    }
    return original(method, params, signal);
  };
  const subscribe = mock.server.subscribe;
  mock.server.subscribe = (listener) =>
    subscribe((method, params) => {
      if (method === "turn/started") {
        listener("account/rateLimits/updated", { rateLimits: {} });
        listener("account/rateLimits/updated", {
          rateLimits: { primary: { usedPercent: 100 } },
        });
      }
      listener(method, params);
    });
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    request(),
    new AbortController().signal,
  );
  expect(result.status).toBe("quota-paused");
  expect(result.quota?.allowed).toBe(false);
});
it.each([
  "auth",
  "plan",
  "provider",
  "tier",
  "override",
  "chatgptUrl",
  "apiUrl",
])("refuses an unverified billing route: %s", async (kind) => {
  const mock = fakeServer(),
    original = mock.server.request;
  mock.server.request = async (method, params, signal) => {
    if (method === "config/read" && kind === "chatgptUrl")
      return {
        config: {
          chatgpt_base_url:
            "https://chatgpt.com/backend-api/?token=never-persist",
        },
      };
    if (method === "config/read" && kind === "apiUrl")
      return { config: { openai_base_url: "https://example.invalid/v1" } };
    if (method === "account/read" && kind === "auth")
      return { account: { type: "apiKey" } };
    if (method === "account/read" && kind === "plan")
      return { account: { type: "chatgpt", planType: "enterprise" } };
    if (method === "config/read" && kind === "override")
      return {
        config: {
          model_providers: { openai: { base_url: "never-persist-url" } },
        },
      };
    const value = await original(method, params, signal);
    if (method === "thread/start" && kind === "provider")
      return { ...object(value), modelProvider: "other" };
    if (method === "thread/start" && kind === "tier")
      return { ...object(value), serviceTier: null };
    return value;
  };
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    request(),
    new AbortController().signal,
  );
  expect(result.status).toBe("failed");
  expect(result.dispatched).toBe(false);
  expect(result.error).toBeTruthy();
  expect(mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  expect(JSON.stringify(result)).not.toContain("never-persist");
});
it("cancels an uncooperative server without retrying or substituting another provider", async () => {
  const mock = fakeServer(),
    original = mock.server.request;
  mock.server.request = async (method, params, signal) =>
    method === "turn/start"
      ? { turn: { id: "waiting-turn" } }
      : original(method, params, signal);
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    { ...request(), timeoutMs: 15 },
    new AbortController().signal,
  );
  expect(result.status).toBe("timeout");
  expect(mock.close).toHaveBeenCalled();
  expect(result.usage).toBeNull();
});
