import { expect, it, vi } from "vitest";
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
          account: { type: "chatgpt", email: "never-persist@example.invalid" },
        };
      if (method === "account/rateLimits/read") return quota;
      if (method === "config/read")
        return {
          config: {
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
        return { thread: { id: "thread-fixture" }, model: params.model };
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
it.each(["review", "implement"] as const)(
  "runs %s with a fresh native thread, structured output and cumulative usage once",
  async (phase) => {
    const mock = fakeServer(),
      agent = new CodexWorkflowAgent(() => mock.server);
    const result = await agent.run(
      request(phase),
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
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
      environments: [],
      sandbox: phase === "review" ? "read-only" : "workspace-write",
    });
    expect(started.config).toMatchObject({
      "features.multi_agent": false,
      "features.hooks": false,
      "features.plugins": false,
      "mcp_servers.outside.enabled": false,
    });
    const turn = mock.calls.find(([m]) => m === "turn/start")![1];
    expect(turn.outputSchema).toEqual(schemas.implement);
    expect(turn.summary).toBe("none");
    expect(turn.sandboxPolicy).toEqual(
      phase === "review"
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
  { rateLimits: { credits: { hasCredits: true, unlimited: false } } },
  { rateLimits: { credits: null } },
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
it("stops when an in-flight native quota update no longer proves included usage", async () => {
  const mock = fakeServer();
  const subscribe = mock.server.subscribe;
  mock.server.subscribe = (listener) =>
    subscribe((method, params) => {
      if (method === "turn/started")
        listener("account/rateLimits/updated", {
          ordinaryUsageAllowed: null,
          rateLimits: { credits: { hasCredits: false, unlimited: false } },
        });
      listener(method, params);
    });
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    request(),
    new AbortController().signal,
  );
  expect(result.status).toBe("quota-paused");
  expect(result.dispatched).toBe(true);
  expect(mock.close).toHaveBeenCalled();
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
