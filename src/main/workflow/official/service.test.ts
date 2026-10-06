import { afterEach, it, expect } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  symlink,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { OfficialWorkflowService, pinClaudeModels } from "./service.js";
import {
  WorkflowFailure,
  type ModelCandidate,
  type OfficialAgent,
} from "./contracts.js";
import { fixtureWorkflowOptions, fixtureAgents } from "./fixtures.js";
const homes: string[] = [];
const services: OfficialWorkflowService[] = [];
it("refuses native DAG before catalog/auth/runtime preflight", async () => {
  const path = await home();
  let lookedUp = false;
  const instance = new OfficialWorkflowService({
    home: path,
    fake: false,
    codexPath: "never-executed",
    options: async () => {
      lookedUp = true;
      throw new Error("must not start");
    },
  });
  services.push(instance);
  const view = await instance.command({
    action: "create",
    provider: "codex",
    mode: "dag",
  });
  expect(lookedUp).toBe(false);
  expect(view.records).toHaveLength(0);
  expect(view.error).toBeTruthy();
});
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
});
async function home() {
  const path = await mkdtemp(join(tmpdir(), "xh-workflow-ui-"));
  homes.push(path);
  return path;
}
function service(
  path: string,
  options?: ConstructorParameters<typeof OfficialWorkflowService>[0]["options"],
) {
  const result = new OfficialWorkflowService({
    home: path,
    fake: true,
    options,
  });
  services.push(result);
  return result;
}
async function wait(
  service: OfficialWorkflowService,
  predicate: (v: ReturnType<OfficialWorkflowService["view"]>) => boolean,
) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const view = await service.command({ action: "list" });
    if (predicate(view)) return view;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Workflow fixture did not reach expected state");
}
it.each([true, false])(
  "exposes per-operation approval and consumes only a matching UI decision (%s)",
  async (allow) => {
    const path = await home();
    let approved: boolean | undefined;
    const instance = service(path, async (cwd) => {
      const fake = fixtureAgents("codex"),
        original = fake.agents.codex.run;
      fake.agents.codex.run = async (request, signal) => {
        if (request.phase === "implement") {
          approved = await request.approve(
            "item/commandExecution/requestApproval",
            {
              requestId: request.requestId,
              sessionId: "native-session",
              turnId: "native-turn",
              itemId: "read",
              command: "Get-Content add.mjs",
              cwd,
              targets: ["add.mjs"],
              reason: "Inspect source",
            },
            signal,
          );
          if (!approved)
            return {
              status: "cancelled",
              dispatched: true,
              usage: null,
              elapsedMs: 1,
              observedModels: [],
            };
        }
        return original(request, signal);
      };
      return fixtureWorkflowOptions(cwd, { agents: fake.agents });
    });
    await instance.command({ action: "create", provider: "codex" });
    const planned = await wait(instance, (v) => !!v.approval);
    await instance.command({ action: "approve", ...planned.approval! });
    const pending = (await wait(instance, (v) => !!v.operationApproval))
      .operationApproval!;
    await instance.command({
      action: "tool_decision",
      id: pending.workflowId,
      approvalId: pending.approvalId,
      digest: "0".repeat(64),
      allow: true,
    });
    expect(instance.view().operationApproval).toEqual(pending);
    const decision = {
      action: "tool_decision" as const,
      id: pending.workflowId,
      approvalId: pending.approvalId,
      digest: pending.digest,
      allow,
    };
    await instance.command(decision);
    await instance.command({ ...decision, allow: !allow });
    await wait(instance, (v) => !v.activeId);
    expect(approved).toBe(allow);
    expect(instance.view().operationApproval).toBeUndefined();
    expect(
      JSON.stringify(
        await readFile(
          join(path, "official-workflows", pending.workflowId, "workflow.json"),
          "utf8",
        ),
      ),
    ).not.toContain(pending.approvalId);
  },
);
it("persists denied approval across restart, asks again, and finishes without replaying planning", async () => {
  const path = await home(),
    first = service(path);
  await first.command({ action: "create", provider: "codex" });
  const planned = await wait(first, (v) => !!v.approval),
    id = planned.approval!.id,
    digest = planned.approval!.digest;
  await first.command({ action: "approve", id, digest: "0".repeat(64) });
  expect(first.view().approval?.digest).toBe(digest);
  await first.command({ action: "cancel", id });
  expect(first.view().records[0]!.record.status).toBe("cancelled");
  await first.close();
  const restored = service(path);
  expect(
    (await restored.command({ action: "list" })).records[0]!.resumeBlocked,
  ).toBeNull();
  await restored.command({ action: "resume", id });
  const approval = await wait(restored, (v) => !!v.approval);
  expect(approval.approval!.digest).toBe(digest);
  await restored.command({ action: "approve", id, digest });
  const complete = await wait(
    restored,
    (v) => !v.activeId && v.records[0]?.record.status === "completed",
  );
  const record = complete.records[0]!.record;
  expect(record.calls.filter((c) => c.phase === "plan")).toHaveLength(1);
  expect(record.calls.map((c) => c.provider)).toEqual([
    "claude",
    "codex",
    "claude",
    "codex",
    "claude",
  ]);
  expect(record.resumed).toBe(1);
  expect(record.checks.map((c) => c.tests[0]!.passed)).toEqual([false, true]);
  expect(
    await readFile(join(path, "official-workflows", id, "report.html"), "utf8"),
  ).toContain("completed");
});
it("preserves an interrupted dispatched effect and refuses resume after restart", async () => {
  const path = await home(),
    controlled = service(path, async (cwd, provider) => {
      const fake = fixtureAgents(provider),
        original = fake.agents.claude.run;
      fake.agents.claude.run = async (request, signal) => {
        if (request.phase !== "implement") return original(request, signal);
        if (!signal.aborted)
          await new Promise<void>((done) =>
            signal.addEventListener("abort", () => done(), { once: true }),
          );
        return {
          status: "cancelled",
          dispatched: true,
          usage: null,
          elapsedMs: 1,
          observedModels: [request.model.model],
        };
      };
      return fixtureWorkflowOptions(cwd, { agents: fake.agents });
    });
  await controlled.command({ action: "create", provider: "claude" });
  const plan = await wait(controlled, (v) => !!v.approval),
    id = plan.approval!.id;
  await controlled.command({
    action: "approve",
    id,
    digest: plan.approval!.digest,
  });
  await wait(
    controlled,
    (v) => v.records[0]?.record.calls.at(-1)?.phase === "implement",
  );
  await controlled.command({ action: "cancel", id });
  const stored = controlled.view().records[0]!.record;
  stored.status = "implementing";
  stored.calls.at(-1)!.status = "running";
  delete stored.finishedAt;
  await writeFile(
    join(path, "official-workflows", id, "workflow.json"),
    JSON.stringify(stored),
  );
  const restored = service(path);
  const result = await restored.command({ action: "resume", id });
  expect(result.activeId).toBeUndefined();
  expect(result.records[0]!.resumeBlocked).toBe("uncertain-effect");
  expect(result.records[0]!.record.status).toBe("interrupted");
  expect(result.records[0]!.record.error).toBe("process-interrupted");
  expect(result.records[0]!.record.calls).toHaveLength(2);
});
it("refuses a changed workspace instead of discarding human edits or starting an agent", async () => {
  const path = await home(),
    created = service(path);
  await created.command({ action: "create", provider: "claude" });
  const plan = await wait(created, (v) => !!v.approval),
    id = plan.approval!.id,
    cwd = plan.records[0]!.record.cwd;
  await created.command({ action: "cancel", id });
  await writeFile(join(cwd, "add.mjs"), "human changes\n");
  const result = await service(path).command({ action: "resume", id });
  expect(result.error).toContain("作業領域");
  expect(result.activeId).toBeUndefined();
  expect(await readFile(join(cwd, "add.mjs"), "utf8")).toBe("human changes\n");
});
it("records a preflight failure without inventing usage or running a model", async () => {
  const path = await home(),
    failed = service(path, async () => {
      throw new Error("fixture metadata unavailable");
    });
  const view = await failed.command({ action: "create", provider: "claude" });
  expect(view.records[0]!.record).toMatchObject({
    status: "failed",
    error: "connection-preflight-unavailable",
    calls: [],
  });
  const restored = await service(path).command({ action: "list" });
  expect(restored.records[0]!.record.calls).toHaveLength(0);
  expect(restored.records[0]!.resumeBlocked).toBe(
    "execution-scope-not-checkpointed",
  );
});
it("configures and restores a production executable without executing it, and refuses missing settings", async () => {
  const path = await home();
  const unconfigured = new OfficialWorkflowService({ home: path, fake: false });
  services.push(unconfigured);
  const refused = await unconfigured.command({
    action: "create",
    provider: "claude",
  });
  expect(refused.available).toBe(false);
  expect(refused.records).toHaveLength(0);
  expect(refused.error).toContain("実行パス");
  const invalid = await unconfigured.command({
    action: "configure",
    codexPath: "relative.exe",
  });
  expect(invalid.available).toBe(false);
  const executable = join(path, "dummy-never-run.exe");
  await writeFile(executable, "not executable");
  const configured = await unconfigured.command({
    action: "configure",
    codexPath: executable,
  });
  expect(configured.connection?.status).toBe("configured");
  const restarted = new OfficialWorkflowService({ home: path, fake: false });
  services.push(restarted);
  expect(
    (await restarted.command({ action: "list" })).connection?.codexPath,
  ).toBe(executable);
});
it("ends consecutive questions and post-work chat after one bounded call and preserves answers", async () => {
  const path = await home(),
    first = service(path);
  for (const text of [
    "こんにちは",
    "先ほどの質問を説明して",
    "コードを説明するだけ",
    "作業ありがとう",
  ]) {
    await first.command({ action: "chat", provider: "claude", text });
    await wait(first, (v) => !v.activeId);
  }
  const records = first.view().records.map((r) => r.record);
  expect(records).toHaveLength(4);
  for (const record of records) {
    expect(record.status).toBe("completed");
    expect(record.calls.map((c) => c.phase)).toEqual(["conversation"]);
    expect(record.plan).toBeUndefined();
    expect(record.checks).toEqual([]);
    expect(record.answer).toContain("模擬回答");
  }
  const restored = await service(path).command({ action: "list" });
  expect(restored.records.map((r) => r.record.answer)).toEqual(
    records.map((r) => r.answer),
  );
  expect(restored.activeId).toBeUndefined();
});
it("pins live Claude candidates to confirmed full model IDs and drops unconfirmed aliases", () => {
  const base = {
    provider: "claude" as const,
    efforts: [null],
    available: true,
    quotaAllowed: true,
    capabilitySource: "official-sdk",
  };
  const pinned = pinClaudeModels([
    { ...base, model: "default", resolvedModel: "claude-opus-5-5" },
    { ...base, model: "opus", resolvedModel: "claude-opus-5-5" },
    { ...base, model: "haiku", resolvedModel: "claude-haiku-4-5-20251001" },
    { ...base, model: "sonnet" },
    { ...base, model: "odd", resolvedModel: "not a model id" },
  ] as ModelCandidate[]);
  expect(pinned.map((m) => [m.model, m.resolvedModel])).toEqual([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"],
  ]);
});
const stopBeforeModels = async (): Promise<never> => {
  throw new Error("stop before any model call");
};
it("keeps the workspace location and Codex path across restarts", async () => {
  const path = await home(),
    root = await home();
  const exe = join(path, "codex.exe");
  await writeFile(exe, "");
  const first = new OfficialWorkflowService({ home: path, fake: false });
  services.push(first);
  await first.command({ action: "configure", codexPath: exe });
  const saved = await first.command({ action: "workspace_root", path: root });
  expect(saved.error).toBeUndefined();
  expect(saved.connection).toMatchObject({
    codexPath: exe,
    workspaceRoot: root,
  });
  const second = new OfficialWorkflowService({ home: path, fake: false });
  services.push(second);
  expect((await second.command({ action: "list" })).connection).toMatchObject({
    codexPath: exe,
    workspaceRoot: root,
  });
  const cleared = await second.command({ action: "workspace_root", path: "" });
  expect(cleared.connection).toMatchObject({
    codexPath: exe,
    workspaceRoot: "",
  });
});
it.each(["relative", "missing", "file", "junction"] as const)(
  "rejects an unusable workspace location (%s) with its reason",
  async (kind) => {
    const path = await home(),
      parent = await home();
    const target =
      kind === "relative"
        ? "relative-folder"
        : kind === "missing"
          ? join(parent, "missing")
          : kind === "file"
            ? join(parent, "file.txt")
            : join(parent, "link");
    if (kind === "file") await writeFile(target, "");
    if (kind === "junction") {
      await mkdir(join(parent, "real"));
      await symlink(join(parent, "real"), target, "junction");
    }
    const instance = service(path);
    const view = await instance.command({
      action: "workspace_root",
      path: target,
    });
    expect(view.error).toMatch(/^合成課題workspaceの保存先/);
    expect(view.connection?.workspaceRoot).toBe("");
  },
);
it("creates new workspaces under the configured location and leaves existing records in place", async () => {
  const path = await home(),
    root = await home();
  const instance = service(path, stopBeforeModels);
  const legacy = await instance.command({
    action: "create",
    provider: "claude",
  });
  const legacyRecord = legacy.records[0]!.record;
  expect(
    relative(
      join(path, "official-workflows", legacyRecord.id),
      legacyRecord.cwd,
    ),
  ).toMatch(/^workspace-/);
  await instance.command({ action: "workspace_root", path: root });
  const created = await instance.command({
    action: "create",
    provider: "claude",
  });
  const record = created.records.find(
    (r) => r.record.id !== legacyRecord.id,
  )!.record;
  expect(relative(join(root, record.id), record.cwd)).toMatch(
    /^workspace-[^\/]+$/,
  );
  expect(
    JSON.parse(
      await readFile(
        join(path, "official-workflows", record.id, "workspace.json"),
        "utf8",
      ),
    ),
  ).toEqual({ workspaceParent: join(root, record.id) });
  // Restart: both records load; the legacy one keeps its original folder.
  const restarted = service(path);
  const view = await restarted.command({ action: "list" });
  const byId = new Map(view.records.map((r) => [r.record.id, r.record]));
  expect(byId.get(legacyRecord.id)?.cwd).toBe(legacyRecord.cwd);
  expect(byId.get(record.id)?.cwd).toBe(record.cwd);
});
it("stops with the reason instead of falling back when the location becomes unusable", async () => {
  const path = await home(),
    root = await home();
  const instance = service(path, stopBeforeModels);
  await instance.command({ action: "workspace_root", path: root });
  await rm(root, { recursive: true, force: true });
  const view = await instance.command({ action: "create", provider: "claude" });
  expect(view.error).toMatch(/^合成課題workspaceの保存先が存在しません/);
  expect(view.records).toHaveLength(0);
  expect(
    (await readdir(join(path, "official-workflows"))).filter((n) =>
      /^[a-f0-9-]{36}$/.test(n),
    ),
  ).toEqual([]);
  // The saved choice is kept and reported again after a restart.
  const restarted = service(path);
  const after = await restarted.command({ action: "list" });
  expect(after.connection?.workspaceRoot).toBe(root);
  expect(after.error).toMatch(/^合成課題workspaceの保存先が存在しません/);
});
it("refuses a product task without a main-model selection before creating anything", async () => {
  const path = await home();
  const instance = new OfficialWorkflowService({
    home: path,
    fake: false,
    codexPath: "C:/never/codex.exe",
  });
  services.push(instance);
  const view = await instance.command({ action: "create", provider: "codex" });
  expect(view.error).toMatch(/^計画モデルが選択されていません/);
  expect(view.records).toHaveLength(0);
});
it("passes the selection fixed at task start to the planner resolution", async () => {
  const path = await home();
  const received: unknown[] = [];
  const instance = service(path, async (_cwd, _provider, planner) => {
    received.push(structuredClone(planner));
    throw new Error("stop before any model call");
  });
  await instance.command({
    action: "create",
    provider: "claude",
    planner: { model: "codex:sol", effort: "high" },
  });
  expect(received).toEqual([{ model: "codex:sol", effort: "high" }]);
});
function officialAgent(
  provider: "claude" | "codex",
  state: "ok" | "unreachable" | "quota-unknown",
) {
  const calls = { discover: 0, run: 0 };
  const agent: OfficialAgent = {
    provider,
    async discover() {
      calls.discover++;
      if (state === "unreachable")
        throw new WorkflowFailure("app-server-closed");
      const model =
        provider === "claude" ? "claude-haiku-4-5-20251001" : "gpt-6-luna";
      return [
        {
          provider,
          model: provider === "claude" ? "haiku" : model,
          resolvedModel: provider === "claude" ? model : undefined,
          efforts: [null, "low"],
          available: true,
          quotaAllowed: state === "ok" ? true : null,
          capabilitySource:
            provider === "claude" ? "official-sdk" : "official-app-server",
        },
      ];
    },
    async run(request) {
      calls.run++;
      return {
        status: "completed",
        dispatched: true,
        output: { summary: `answer from ${request.model.model}` },
        observedModels: [request.model.model],
        usage: null,
        elapsedMs: 1,
      };
    },
  };
  return { agent, calls };
}
async function liveService(
  claude: ReturnType<typeof officialAgent>,
  codex: ReturnType<typeof officialAgent>,
  codexPath?: string,
) {
  const path = await home();
  const instance = new OfficialWorkflowService({
    home: path,
    fake: false,
    codexPath,
    agents: { claude: claude.agent, codex: codex.agent },
  });
  services.push(instance);
  return instance;
}
it.each([
  ["Codex path unset", undefined, "unreachable"],
  ["Codex unreachable", "C:/configured/codex.exe", "unreachable"],
  ["Codex usage unknown", "C:/configured/codex.exe", "quota-unknown"],
] as const)(
  "answers a Claude question with only Claude available (%s), never contacting Codex",
  async (_label, codexPath, codexState) => {
    const claude = officialAgent("claude", "ok"),
      codex = officialAgent("codex", codexState);
    const instance = await liveService(claude, codex, codexPath);
    expect((await instance.command({ action: "list" })).storageReady).toBe(
      true,
    );
    await instance.command({
      action: "chat",
      provider: "claude",
      text: "質問",
    });
    const view = await wait(instance, (v) => !v.activeId);
    expect(view.error).toBeUndefined();
    const record = view.records[0]!.record;
    expect(record.status).toBe("completed");
    expect(record.answer).toBe("answer from claude-haiku-4-5-20251001");
    expect(record.plan).toBeUndefined();
    expect(codex.calls).toEqual({ discover: 0, run: 0 });
  },
);
it.each([
  [
    "Codex path unset",
    undefined,
    "unreachable",
    /^公式Codexの実行パスを設定してください/,
    0,
  ],
  [
    "Codex unreachable",
    "C:/configured/codex.exe",
    "unreachable",
    /^公式Codex接続確認: app-server-closed/,
    1,
  ],
  [
    "Codex usage unknown",
    "C:/configured/codex.exe",
    "quota-unknown",
    /^質問先のCodexを利用できないか/,
    1,
  ],
] as const)(
  "stops a Codex question with the reason when Codex is unusable (%s), without switching to Claude",
  async (_label, codexPath, codexState, reason, discovered) => {
    const claude = officialAgent("claude", "ok"),
      codex = officialAgent("codex", codexState);
    const instance = await liveService(claude, codex, codexPath);
    const view = await instance.command({
      action: "chat",
      provider: "codex",
      text: "質問",
    });
    expect(view.error).toMatch(reason);
    expect(codex.calls).toEqual({ discover: discovered, run: 0 });
    expect(claude.calls).toEqual({ discover: 0, run: 0 });
    for (const { record } of view.records) {
      expect(record.answer).toBeUndefined();
      expect(record.calls).toEqual([]);
    }
  },
);
it("stops a Claude question when Claude is unusable even though Codex is available", async () => {
  const claude = officialAgent("claude", "quota-unknown"),
    codex = officialAgent("codex", "ok");
  const instance = await liveService(claude, codex, "C:/configured/codex.exe");
  const view = await instance.command({
    action: "chat",
    provider: "claude",
    text: "質問",
  });
  expect(view.error).toMatch(/^質問先のClaude（Haiku）を利用できないか/);
  expect(claude.calls).toEqual({ discover: 1, run: 0 });
  expect(codex.calls).toEqual({ discover: 0, run: 0 });
});
it.each(["claude", "codex"] as const)(
  "keeps requiring both companies for the plan/implement/review workflow (%s unavailable)",
  async (down) => {
    const claude = officialAgent(
        "claude",
        down === "claude" ? "unreachable" : "ok",
      ),
      codex = officialAgent("codex", down === "codex" ? "unreachable" : "ok");
    const instance = await liveService(
      claude,
      codex,
      "C:/configured/codex.exe",
    );
    const view = await instance.command({
      action: "create",
      provider: "codex",
      planner: { model: "claude:haiku", effort: null },
    });
    expect(view.error).toMatch(
      down === "claude" ? /^公式Claude接続確認/ : /^公式Codex接続確認/,
    );
    expect(claude.calls.run + codex.calls.run).toBe(0);
    expect(view.activeId).toBeUndefined();
  },
);
