import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexWorkflowAgent,
  codexDeveloperInstructions,
  codexQuota,
} from "./codex.js";
import { commandApproval } from "./command-approval.js";
import type { AppServerPort } from "./app-server-rpc.js";
import {
  createSyntheticWorkspace,
  fixtureAgents,
  fixtureModels,
  fixtureTest,
  fixtureWorkflowOptions,
} from "./fixtures.js";
import { runOfficialSingleTask } from "./runtime.js";
import { officialWorkflowReport } from "./report.js";
import { schemas, type AgentRequest } from "./contracts.js";
import { normalizeTokens } from "../../providers/token-usage.js";
import { object } from "./usage.js";
import { communicationInput } from "./communication.js";
import { publicEventRecorder } from "./public-events.js";
it("stops before turn/start when public event persistence fails", async () => {
  const mock = fakeServer(),
    event = vi.fn(async () => {
      throw Error("fixture write failure");
    });
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    { ...request(), event },
    new AbortController().signal,
  );
  expect(result.status).toBe("failed");
  expect(result.dispatched).toBe(false);
  expect(event).toHaveBeenCalledTimes(1);
  expect(mock.calls.some(([m]) => m === "turn/start")).toBe(false);
  expect(mock.close).toHaveBeenCalled();
});
it("records public App Server response once and rejects foreign thread events", async () => {
  const mock = fakeServer(),
    c = communicationInput({}),
    record = publicEventRecorder(c);
  const run = mock.server.request.bind(mock.server);
  mock.server.request = async (method, params, signal) => {
    if (method === "turn/start")
      mock.emit("item/completed", {
        threadId: "foreign",
        item: { id: "foreign", type: "agentMessage", text: "private-foreign" },
      });
    return run(method, params, signal);
  };
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    {
      ...request(),
      event: async (e) => {
        record(e);
      },
    },
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(c.events?.filter((e) => e.kind === "response")).toHaveLength(1);
  expect(c.events?.at(-1)?.status).toBe("completed");
  expect(JSON.stringify(c)).not.toContain("private-foreign");
  expect(mock.calls.filter(([m]) => m === "turn/start")).toHaveLength(1);
});
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
            item: {
              id: "exec-fixture",
              type: "functionCallOutput",
              name: "exec",
              output: "never-persist-tool-body",
            },
          });
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
function commandFailureServer(
  delivery: "item" | "final" | "both",
  source: string | undefined = "unifiedExecStartup",
  before?: (mock: ReturnType<typeof fakeServer>) => void,
) {
  const mock = fakeServer(),
    original = mock.server.request;
  mock.server.request = async (method, raw, signal) => {
    if (method !== "turn/start") return original(method, raw, signal);
    mock.calls.push([method, object(raw)]);
    queueMicrotask(() => {
      const binding = { threadId: "thread-fixture", turnId: "turn-fixture" };
      mock.emit("turn/started", {
        ...binding,
        turn: { id: binding.turnId },
      });
      before?.(mock);
      const item = {
        id: "startup-fixture",
        type: "commandExecution",
        status: "failed",
        source,
        exitCode: -1,
        durationMs: 0,
        command: "never-persist-command",
        aggregatedOutput: "never-persist-token never-persist-thinking",
      };
      if (delivery !== "final") {
        mock.emit("item/completed", { ...binding, item });
        mock.emit("item/completed", { ...binding, item });
      }
      const answer = {
        id: "answer",
        type: "agentMessage",
        text: JSON.stringify({ summary: "No edits" }),
      };
      mock.emit("turn/completed", {
        ...binding,
        turn: {
          id: binding.turnId,
          status: "completed",
          items: [...(delivery === "item" ? [] : [item]), answer],
        },
      });
    });
    return { turn: { id: "turn-fixture" } };
  };
  return mock;
}
it.each(["item", "final", "both"] as const)(
  "stops native startup failure despite a completed turn (%s), without duplicate evidence or raw text",
  async (delivery) => {
    const mock = commandFailureServer(delivery),
      r = request("implement");
    const result = await new CodexWorkflowAgent(() => mock.server).run(
      r,
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("公式Codexのコマンド実行準備に失敗");
    expect(result.error).toContain("native-exec-startup-failed");
    expect(result.diagnostics?.stops).toEqual(["native-exec-startup-failed"]);
    expect(result.diagnostics?.commandRuns).toHaveLength(1);
    expect(r.tool).toHaveBeenCalledTimes(1);
    expect(
      mock.calls.filter(([method]) => method === "turn/start"),
    ).toHaveLength(1);
    expect(
      mock.calls.filter(([method]) => method === "turn/interrupt"),
    ).toHaveLength(1);
    expect(mock.close).toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("never-persist");
  },
);
it.each(["agent", "unknown", undefined])(
  "does not infer a startup failure from exit -1 or duration zero alone (%s)",
  async (source) => {
    const mock = commandFailureServer("both", source ?? "");
    const result = await new CodexWorkflowAgent(() => mock.server).run(
      request("implement"),
      new AbortController().signal,
    );
    expect(result.status).toBe("completed");
    expect(result.error).toBeUndefined();
    expect(result.diagnostics?.commandRuns?.[0]).toMatchObject({
      status: "failed",
      exitCode: -1,
    });
    expect(mock.calls.some(([method]) => method === "turn/interrupt")).toBe(
      false,
    );
  },
);
it("does not replace cancellation or a prior quota stop with a late startup failure", async () => {
  for (const reason of ["cancel", "quota"]) {
    const controller = new AbortController();
    const mock = commandFailureServer(
      "both",
      "unifiedExecStartup",
      (server) => {
        if (reason === "cancel") controller.abort();
        else
          server.emit("account/rateLimits/updated", {
            ordinaryUsageAllowed: false,
          });
      },
    );
    const result = await new CodexWorkflowAgent(() => mock.server).run(
      request("implement"),
      controller.signal,
    );
    expect(result.status).toBe(
      reason === "cancel" ? "cancelled" : "quota-paused",
    );
    expect(result.error ?? "").not.toContain("native-exec-startup-failed");
  }
});
it("does not attribute another thread's startup failure to this request", async () => {
  const mock = commandFailureServer("item", "agent", (server) => {
    server.emit("item/completed", {
      threadId: "another-thread",
      turnId: "turn-fixture",
      item: {
        id: "other",
        type: "commandExecution",
        status: "failed",
        source: "unifiedExecStartup",
      },
    });
  });
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    request("implement"),
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(result.diagnostics?.stops).toBeUndefined();
  expect(result.diagnostics?.commandRuns).toHaveLength(1);
});
it("preserves startup failure in workflow history and report without no-changes, commit, tests or review", async () => {
  const cwd = await createSyntheticWorkspace();
  try {
    const fake = fixtureAgents("codex"),
      mock = commandFailureServer("final");
    fake.agents.codex = new CodexWorkflowAgent(() => mock.server);
    const result = await runOfficialSingleTask(
      fixtureWorkflowOptions(cwd, { agents: fake.agents }),
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("native-exec-startup-failed");
    expect(result.error).not.toContain("no-changes");
    expect(result.calls.map((call) => call.phase)).toEqual([
      "plan",
      "implement",
    ]);
    expect(result.commits).toEqual([]);
    expect(result.checks).toEqual([]);
    expect(result.reviews).toEqual([]);
    expect(result.correctionRounds).toBe(0);
    expect(officialWorkflowReport(result)).toContain(
      "native-exec-startup-failed",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
});
it.each(["allow", "deny", "changed", "duplicate"])(
  "routes a scoped operation through request.approve: %s",
  async (mode) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-codex-approval-"));
    try {
      await writeFile(join(cwd, "add.mjs"), "synthetic");
      const mock = fakeServer(),
        original = mock.server.request;
      let decision: unknown, duplicate: unknown;
      const params = {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        itemId: "read-fixture",
        cwd,
        command: "Get-Content add.mjs",
      };
      const r = {
        ...request("implement"),
        cwd,
        requestId: "11111111-1111-4111-8111-111111111111",
      };
      r.approve = vi.fn(async () => {
        if (mode === "changed") params.command = "Get-Content .env";
        return mode !== "deny";
      });
      mock.server.request = async (method, raw, signal) => {
        if (method !== "turn/start") return original(method, raw, signal);
        queueMicrotask(() => {
          void (async () => {
            mock.emit("turn/started", {
              threadId: params.threadId,
              turn: { id: params.turnId },
            });
            decision = await mock.approval()(
              "item/commandExecution/requestApproval",
              params,
            );
            if (mode === "duplicate")
              duplicate = await mock.approval()(
                "item/commandExecution/requestApproval",
                params,
              );
            mock.emit("turn/completed", {
              threadId: params.threadId,
              turn: { id: params.turnId, status: "completed" },
            });
          })();
        });
        return { turn: { id: params.turnId } };
      };
      await new CodexWorkflowAgent(() => mock.server).run(
        r,
        new AbortController().signal,
      );
      expect(r.approve).toHaveBeenCalledTimes(1);
      expect(decision).toEqual({
        decision: mode === "deny" || mode === "changed" ? "decline" : "accept",
      });
      if (mode === "duplicate")
        expect(duplicate).toEqual({ decision: "decline" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
it.each([
  [true, "accept", undefined],
  ["declined", "decline", "user-declined"],
  ["expired", "decline", "approval-expired"],
  ["cancelled", "decline", "approval-cancelled"],
] as const)(
  "pauses the phase limit while a person decides and records why: %s",
  async (outcome, expected, reason) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-codex-approval-wait-"));
    try {
      await writeFile(join(cwd, "add.mjs"), "synthetic");
      const mock = fakeServer(),
        original = mock.server.request;
      let decision: unknown;
      const params = {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        itemId: "read-fixture",
        cwd,
        command: "Get-Content add.mjs",
      };
      // The person takes longer than the whole 1s phase limit.
      const r = {
        ...request("implement"),
        cwd,
        requestId: "11111111-1111-4111-8111-111111111111",
        approve: vi.fn(async () => {
          await new Promise((done) => setTimeout(done, 1300));
          return outcome;
        }),
      };
      mock.server.request = async (method, raw, signal) => {
        if (method !== "turn/start") return original(method, raw, signal);
        queueMicrotask(() => {
          void (async () => {
            mock.emit("turn/started", {
              threadId: params.threadId,
              turn: { id: params.turnId },
            });
            decision = await mock.approval()(
              "item/commandExecution/requestApproval",
              params,
            );
            mock.emit("turn/completed", {
              threadId: params.threadId,
              turn: { id: params.turnId, status: "completed" },
            });
          })();
        });
        return { turn: { id: params.turnId } };
      };
      const result = await new CodexWorkflowAgent(() => mock.server).run(
        r,
        new AbortController().signal,
      );
      expect(decision).toEqual({ decision: expected });
      expect(result.status).not.toBe("timeout");
      const approval = result.diagnostics?.approvals?.at(-1);
      expect(approval).toMatchObject({
        decision: outcome === true ? "allowed" : "denied",
      });
      expect(approval?.reason).toBe(reason);
      if (reason) expect(result.error).toContain(`binding: ${reason}`);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
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
      tools: [{ name: "exec", status: "completed" }],
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
      "features.code_mode": phase === "implement",
      "features.code_mode_host": phase === "implement",
      "features.code_mode_only": false,
      "mcp_servers.outside.enabled": false,
      forced_login_method: "chatgpt",
      service_tier: "default",
    });
    const turn = mock.calls.find(([m]) => m === "turn/start")![1];
    expect(turn.outputSchema).toEqual(schemas.implement);
    expect(turn.summary).toBe("none");
    expect(turn.serviceTierForTurn).toBe("default");
    expect(turn.approvalPolicy).toBe(
      phase === "implement" ? "untrusted" : "never",
    );
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
it.each([true, false])(
  "records a fixed denial stage and reason, and command text only for synthetic diagnostics (%s)",
  async (diagnosticText) => {
    const mock = fakeServer(),
      original = mock.server.request;
    let decision: unknown;
    const params = {
      threadId: "thread-fixture",
      turnId: "turn-fixture",
      itemId: "exec-fixture",
      cwd: process.cwd(),
      command:
        "pwsh.exe -NoProfile -Command Get-Content add.mjs Bearer never-persist-token",
    };
    mock.server.request = async (method, raw, signal) => {
      if (method !== "turn/start") return original(method, raw, signal);
      queueMicrotask(() => {
        void (async () => {
          mock.emit("turn/started", {
            threadId: params.threadId,
            turn: { id: params.turnId },
          });
          decision = await mock.approval()(
            "item/commandExecution/requestApproval",
            params,
          );
          mock.emit("turn/completed", {
            threadId: params.threadId,
            turn: { id: params.turnId, status: "completed" },
          });
        })();
      });
      return { turn: { id: params.turnId } };
    };
    const r = { ...request("implement"), diagnosticText };
    const result = await new CodexWorkflowAgent(() => mock.server).run(
      r,
      new AbortController().signal,
    );
    expect(decision).toEqual({ decision: "decline" });
    expect(r.approve).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    expect(result.error).toContain("program: shell-wrapper");
    const [entry] = result.diagnostics!.approvals!;
    expect(entry).toMatchObject({
      method: "item/commandExecution/requestApproval",
      decision: "denied",
      source: "plan",
      stage: "program",
      reason: "shell-wrapper",
      shape: { program: "pwsh.exe", wrapper: true, cwd: "same" },
    });
    if (diagnosticText) {
      expect(entry!.command).toContain("Get-Content add.mjs");
      expect(entry!.command).toContain("[redacted]");
    } else expect(entry!.command).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("never-persist-token");
  },
);
it("records binding denials such as a mismatched turn without asking the user", async () => {
  const mock = fakeServer(),
    original = mock.server.request;
  let decision: unknown;
  mock.server.request = async (method, raw, signal) => {
    if (method !== "turn/start") return original(method, raw, signal);
    queueMicrotask(() => {
      void (async () => {
        mock.emit("turn/started", {
          threadId: "thread-fixture",
          turn: { id: "turn-fixture" },
        });
        decision = await mock.approval()(
          "item/commandExecution/requestApproval",
          {
            threadId: "thread-fixture",
            turnId: "other-turn",
            itemId: "exec",
            cwd: process.cwd(),
            command: "Get-Content add.mjs",
          },
        );
        mock.emit("turn/completed", {
          threadId: "thread-fixture",
          turn: { id: "turn-fixture", status: "completed" },
        });
      })();
    });
    return { turn: { id: "turn-fixture" } };
  };
  const r = request("implement");
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    r,
    new AbortController().signal,
  );
  expect(decision).toEqual({ decision: "decline" });
  expect(r.approve).not.toHaveBeenCalled();
  expect(result.diagnostics!.approvals).toEqual([
    {
      method: "item/commandExecution/requestApproval",
      decision: "denied",
      source: "plan",
      stage: "binding",
      reason: "turn-mismatch",
    },
  ]);
});
it("asks once for the wrapped Codex read and answers only a one-time accept, never the amendment", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-codex-wrapped-"));
  try {
    await writeFile(join(cwd, "add.mjs"), "synthetic");
    const mock = fakeServer(),
      original = mock.server.request;
    let decision: unknown;
    const B = "\\";
    const command = `"C:${B + B}Windows${B + B}System32${B + B}WindowsPowerShell${B + B}v1.0${B + B}powershell.exe" -Command 'Get-Content -Raw add.mjs'`;
    const params = {
      kind: "command",
      threadId: "thread-fixture",
      turnId: "turn-fixture",
      itemId: "exec-fixture",
      startedAtMs: 1,
      environmentId: null,
      cwd,
      command,
      commandActions: [{ type: "read" }],
      proposedExecpolicyAmendment: ["Get-Content"],
      availableDecisions: [
        "accept",
        {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["Get-Content"],
          },
        },
        "decline",
      ],
    };
    mock.server.request = async (method, raw, signal) => {
      if (method !== "turn/start") return original(method, raw, signal);
      queueMicrotask(() => {
        void (async () => {
          mock.emit("turn/started", {
            threadId: params.threadId,
            turn: { id: params.turnId },
          });
          decision = await mock.approval()(
            "item/commandExecution/requestApproval",
            params,
          );
          mock.emit("turn/completed", {
            threadId: params.threadId,
            turn: { id: params.turnId, status: "completed" },
          });
        })();
      });
      return { turn: { id: params.turnId } };
    };
    const r = {
      ...request("implement"),
      cwd,
      requestId: "11111111-1111-4111-8111-111111111111",
    };
    r.approve = vi.fn(async () => true);
    await new CodexWorkflowAgent(() => mock.server).run(
      r,
      new AbortController().signal,
    );
    expect(r.approve).toHaveBeenCalledTimes(1);
    expect(vi.mocked(r.approve).mock.calls[0]![1]).toMatchObject({
      command,
      cwd,
      targets: ["add.mjs"],
      itemId: "exec-fixture",
    });
    expect(decision).toEqual({ decision: "accept" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it.each([
  [
    "turn failure",
    (emit: (m: string, p: Record<string, unknown>) => void) =>
      emit("turn/completed", {
        threadId: "thread-fixture",
        turn: {
          id: "turn-fixture",
          status: "failed",
          error: {
            message: "never-persist-native-message",
            codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 502 } },
          },
        },
      }),
    { nativeErrors: [{ source: "turn", info: "httpConnectionFailed" }] },
    "httpConnectionFailed",
  ],
  [
    "model reroute",
    (emit: (m: string, p: Record<string, unknown>) => void) => {
      emit("model/rerouted", {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        toModel: "other-model",
      });
      emit("turn/completed", {
        threadId: "thread-fixture",
        turn: { id: "turn-fixture", status: "completed" },
      });
    },
    { stops: ["model-rerouted"] },
    "model-rerouted",
  ],
] as const)(
  "records a fixed reason for a %s instead of ending silently",
  async (_label, events, expected, code) => {
    const mock = fakeServer(),
      original = mock.server.request;
    mock.server.request = async (method, raw, signal) => {
      if (method !== "turn/start") return original(method, raw, signal);
      queueMicrotask(() => {
        mock.emit("turn/started", {
          threadId: "thread-fixture",
          turn: { id: "turn-fixture" },
        });
        events(mock.emit);
      });
      return { turn: { id: "turn-fixture" } };
    };
    const result = await new CodexWorkflowAgent(() => mock.server).run(
      request("implement"),
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.diagnostics).toMatchObject(expected);
    expect(result.error).toContain(code);
    expect(JSON.stringify(result)).not.toContain("never-persist");
  },
);
it("records the method of an unsupported server request and stops", async () => {
  const mock = fakeServer(),
    original = mock.server.request;
  let outcome: unknown;
  mock.server.request = async (method, raw, signal) => {
    if (method !== "turn/start") return original(method, raw, signal);
    queueMicrotask(() => {
      void (async () => {
        mock.emit("turn/started", {
          threadId: "thread-fixture",
          turn: { id: "turn-fixture" },
        });
        outcome = await mock
          .approval()("item/permissions/requestApproval", {
            threadId: "thread-fixture",
            turnId: "turn-fixture",
          })
          .catch(() => "rejected");
      })();
    });
    return { turn: { id: "turn-fixture" } };
  };
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    request("implement"),
    new AbortController().signal,
  );
  expect(outcome).toBe("rejected");
  expect(result.status).toBe("failed");
  expect(result.diagnostics).toMatchObject({
    stops: ["unsupported-server-request"],
    approvals: [
      {
        method: "item/permissions/requestApproval",
        stage: "envelope",
        reason: "method-unsupported",
      },
    ],
  });
});
it.each([
  [[], true],
  [
    [{ environmentId: "remote", cwd: "C:/remote", runtimeWorkspaceRoots: [] }],
    false,
  ],
])(
  "allows the implicit environment id only when thread/start selected no environment (%j)",
  async (environments, asked) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-codex-env-"));
    try {
      await writeFile(join(cwd, "add.mjs"), "synthetic");
      const mock = fakeServer(),
        original = mock.server.request;
      let decision: unknown;
      const params = {
        kind: "command",
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        itemId: "exec-fixture",
        environmentId: "local",
        cwd,
        command: "Get-Content -Raw add.mjs",
        availableDecisions: ["accept", "cancel"],
      };
      mock.server.request = async (method, raw, signal) => {
        if (method === "thread/start") {
          const started = object(await original(method, raw, signal));
          return {
            ...started,
            thread: { ...object(started.thread), environments },
          };
        }
        if (method !== "turn/start") return original(method, raw, signal);
        queueMicrotask(() => {
          void (async () => {
            mock.emit("turn/started", {
              threadId: params.threadId,
              turn: { id: params.turnId },
            });
            decision = await mock.approval()(
              "item/commandExecution/requestApproval",
              params,
            );
            mock.emit("turn/completed", {
              threadId: params.threadId,
              turn: { id: params.turnId, status: "completed" },
            });
          })();
        });
        return { turn: { id: params.turnId } };
      };
      const r = {
        ...request("implement"),
        cwd,
        requestId: "11111111-1111-4111-8111-111111111111",
      };
      r.approve = vi.fn(async () => true);
      const result = await new CodexWorkflowAgent(() => mock.server).run(
        r,
        new AbortController().signal,
      );
      expect(r.approve).toHaveBeenCalledTimes(asked ? 1 : 0);
      expect(decision).toEqual({ decision: asked ? "accept" : "decline" });
      expect(result.diagnostics?.threadEnvironments).toBe(environments.length);
      if (!asked)
        expect(result.diagnostics?.approvals?.[0]).toMatchObject({
          stage: "envelope",
          reason: "environment",
          shape: { environment: "local" },
        });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
it.each([
  [false, "aggregated"],
  [true, "aggregated"],
  [true, "delta"],
] as const)(
  "records a finished command run bound to its item (synthetic text %s, output from %s)",
  async (diagnosticText, outputSource) => {
    const mock = fakeServer(),
      original = mock.server.request;
    const failure =
      "Get-Content : Access denied Bearer never-persist-token\r\n";
    mock.server.request = async (method, raw, signal) => {
      if (method !== "turn/start") return original(method, raw, signal);
      queueMicrotask(() => {
        mock.emit("turn/started", {
          threadId: "thread-fixture",
          turn: { id: "turn-fixture" },
        });
        if (outputSource === "delta")
          mock.emit("item/commandExecution/outputDelta", {
            threadId: "thread-fixture",
            turnId: "turn-fixture",
            itemId: "exec-fixture",
            delta: failure,
          });
        mock.emit("item/completed", {
          threadId: "thread-fixture",
          turnId: "turn-fixture",
          item: {
            id: "exec-fixture",
            type: "commandExecution",
            status: "failed",
            command: "Get-Content add.mjs",
            cwd: process.cwd(),
            source: "agent",
            exitCode: 1,
            durationMs: 42,
            aggregatedOutput: outputSource === "aggregated" ? failure : null,
          },
        });
        mock.emit("turn/completed", {
          threadId: "thread-fixture",
          turn: { id: "turn-fixture", status: "completed" },
        });
      });
      return { turn: { id: "turn-fixture" } };
    };
    const result = await new CodexWorkflowAgent(() => mock.server).run(
      { ...request("implement"), diagnosticText },
      new AbortController().signal,
    );
    const [run] = result.diagnostics!.commandRuns!;
    expect(run).toMatchObject({
      itemId: "exec-fixture",
      status: "failed",
      exitCode: 1,
      durationMs: 42,
      source: "agent",
      cwd: "same",
      argv: "not-provided",
      outputSource: diagnosticText ? outputSource : "aggregated",
      outputTruncated: false,
    });
    if (diagnosticText) {
      expect(run!.command).toBe("Get-Content add.mjs");
      expect(run!.cwdPath).toBe(process.cwd());
      expect(run!.output).toContain("Access denied");
      expect(run!.output).toContain("[redacted]");
    } else {
      expect(run!.command).toBeUndefined();
      expect(run!.output).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain("never-persist-token");
  },
);
it("keeps unreported command values null instead of inferring them", async () => {
  const mock = fakeServer(),
    original = mock.server.request;
  mock.server.request = async (method, raw, signal) => {
    if (method !== "turn/start") return original(method, raw, signal);
    queueMicrotask(() => {
      mock.emit("turn/started", {
        threadId: "thread-fixture",
        turn: { id: "turn-fixture" },
      });
      mock.emit("item/completed", {
        threadId: "thread-fixture",
        turnId: "turn-fixture",
        item: {
          id: "exec-fixture",
          type: "commandExecution",
          status: "failed",
        },
      });
      mock.emit("turn/completed", {
        threadId: "thread-fixture",
        turn: { id: "turn-fixture", status: "completed" },
      });
    });
    return { turn: { id: "turn-fixture" } };
  };
  const result = await new CodexWorkflowAgent(() => mock.server).run(
    { ...request("implement"), diagnosticText: true },
    new AbortController().signal,
  );
  expect(result.diagnostics!.commandRuns).toEqual([
    {
      itemId: "exec-fixture",
      status: "failed",
      exitCode: null,
      durationMs: null,
      source: null,
      cwd: "missing",
      argv: "not-provided",
      outputSource: "none",
      outputTruncated: false,
    },
  ]);
});
it("tells implementation threads exactly the reads XHarness can route to approval and leaves tests to XHarness", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-codex-instructions-"));
  try {
    await writeFile(join(cwd, "add.mjs"), "synthetic");
    const r = { ...request("implement"), cwd };
    const text = codexDeveloperInstructions(r, false);
    expect(text).toContain('"Get-Content -Raw add.mjs"');
    // Registered tests are run by XHarness, not listed for the model.
    expect(text).not.toContain(fixtureTest().command);
    expect(text).toMatch(/Do not run the tests yourself/);
    expect(text).toMatch(/Never combine commands/);
    expect(text).toMatch(/rg, ls, dir, Get-ChildItem, git/);
    // Each listed command is one the classifier routes to approval; a test the
    // model runs anyway is still classified as before.
    const params = (command: string) => ({
      command,
      cwd,
      threadId: "t",
      turnId: "u",
      itemId: "i",
    });
    expect(
      await commandApproval(r, params("Get-Content -Raw add.mjs")),
    ).toMatchObject({ targets: ["add.mjs"] });
    expect(await commandApproval(r, params(fixtureTest().command))).toBe(
      "test",
    );
    // Read-only phases get no command list.
    expect(codexDeveloperInstructions(r, true)).not.toMatch(
      /Allowed shell commands/,
    );
    // Implement and fix threads receive it; a review thread does not.
    for (const [phase, listed] of [
      ["implement", true],
      ["fix", true],
      ["review", false],
    ] as const) {
      const mock = fakeServer();
      await new CodexWorkflowAgent(() => mock.server).run(
        { ...request(phase), cwd },
        new AbortController().signal,
      );
      const started = mock.calls.find(([m]) => m === "thread/start")![1];
      expect(
        String(started.developerInstructions).includes(
          "Allowed shell commands",
        ),
      ).toBe(listed);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
