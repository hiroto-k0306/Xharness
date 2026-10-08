import { afterEach, it, expect, vi } from "vitest";
vi.mock("./codex-installation.js", async (load) => ({
  ...(await load<typeof import("./codex-installation.js")>()),
  discoverCodexInstallation: vi.fn(async () => {
    throw new Error("公式Codexの実行パスを設定してください");
  }),
}));
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
  type AgentRequest,
} from "./contracts.js";
import { fixtureWorkflowOptions, fixtureAgents } from "./fixtures.js";
import { resolveRole } from "../../config/catalog.js";
/** The catalog question models (roles.question), as the service resolves them. */
const QUESTION_MODELS = {
  claude: resolveRole("question", "claude").id,
  codex: resolveRole("question", "codex").id,
};
import { loadModelCatalog } from "../../config/model-catalog.js";
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
  timeoutMs = 10000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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
    let approved: Awaited<ReturnType<AgentRequest["approve"]>> | undefined;
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
          if (approved !== true)
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
    expect(approved).toBe(allow || "declined");
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
    // This case performs two commits and three independent reviews, with
    // attributes checked before each Git operation; bound the whole cycle.
    20000,
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
    planner: { model: "claude-opus-4-6" },
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
it("preserves a missing legacy override until explicitly returning to automatic discovery", async () => {
  const path = await home();
  const storage = join(path, "official-workflows");
  await mkdir(storage);
  const missing = join(path, "missing.exe");
  await writeFile(
    join(storage, "connection.json"),
    JSON.stringify({ codexPath: missing }),
  );
  const discoverCodex = vi.fn(async () => ({
    path: "registered-codex.exe",
    package: "registered-package",
  }));
  const instance = new OfficialWorkflowService({
    home: path,
    fake: false,
    discoverCodex,
  });
  services.push(instance);
  const fixed = await instance.command({ action: "list" });
  expect(fixed.connection).toMatchObject({
    codexMode: "fixed",
    codexPath: missing,
    status: "unconfigured",
  });
  expect(discoverCodex).not.toHaveBeenCalled();
  const automatic = await instance.command({ action: "configure_auto" });
  expect(automatic.connection).toMatchObject({
    codexMode: "auto",
    codexPath: "registered-codex.exe",
    status: "configured",
  });
  expect(
    JSON.parse(await readFile(join(storage, "connection.json"), "utf8")),
  ).toEqual({ codexMode: "auto" });
  const restarted = new OfficialWorkflowService({
    home: path,
    fake: false,
    discoverCodex: async () => ({
      path: "new-registration.exe",
      package: "new-package",
    }),
  });
  services.push(restarted);
  expect(
    (await restarted.command({ action: "list" })).connection?.codexPath,
  ).toBe("new-registration.exe");
});
it("rechecks registration between tasks and refuses switching an active task", async () => {
  let executable = "registered-old.exe";
  const discoverCodex = vi.fn(async () => ({
    path: executable,
    package: executable,
  }));
  const instance = new OfficialWorkflowService({
    home: await home(),
    fake: false,
    discoverCodex,
    options: async (cwd) => fixtureWorkflowOptions(cwd),
  });
  services.push(instance);
  await instance.command({ action: "list" });
  executable = "registered-next.exe";
  await instance.command({
    action: "create",
    provider: "claude",
    planner: { model: "fixture" },
  });
  const active = await wait(instance, (view) => !!view.approval);
  expect(active.connection?.codexPath).toBe(executable);
  const reads = discoverCodex.mock.calls.length;
  executable = "registered-later.exe";
  const refused = await instance.command({ action: "configure_auto" });
  expect(refused.error).toBe("別のworkflowが実行中です");
  expect(refused.connection?.codexPath).toBe("registered-next.exe");
  expect(discoverCodex).toHaveBeenCalledTimes(reads);
  await instance.command({ action: "cancel", id: active.activeId! });
  await instance.command({
    action: "create",
    provider: "claude",
    planner: { model: "fixture" },
  });
  expect(
    (await wait(instance, (view) => !!view.approval)).connection?.codexPath,
  ).toBe(executable);
});
it("does not rewrite an unreadable connection as automatic when saving an unrelated setting", async () => {
  const path = await home(),
    storage = join(path, "official-workflows");
  await mkdir(storage);
  const file = join(storage, "connection.json");
  await writeFile(file, "invalid-json");
  const discoverCodex = vi.fn(async () => ({
    path: "registered.exe",
    package: "registered",
  }));
  const instance = new OfficialWorkflowService({
    home: path,
    fake: false,
    discoverCodex,
  });
  services.push(instance);
  const blocked = await instance.command({
    action: "workspace_root",
    path: "",
  });
  expect(blocked.error).toContain("接続設定が不正");
  expect(await readFile(file, "utf8")).toBe("invalid-json");
  expect(discoverCodex).not.toHaveBeenCalled();
  expect(
    (await instance.command({ action: "configure_auto" })).connection?.status,
  ).toBe("configured");
});
it("keeps fixed mode if persisting the switch to automatic fails", async () => {
  const path = await home(),
    exe = join(path, "codex.exe");
  await writeFile(exe, "never run");
  const discoverCodex = vi.fn(async () => ({
    path: "registered.exe",
    package: "registered",
  }));
  const instance = new OfficialWorkflowService({
    home: path,
    fake: false,
    codexPath: exe,
    discoverCodex,
  });
  services.push(instance);
  await instance.command({ action: "list" });
  await mkdir(join(path, "official-workflows/connection.json"));
  const result = await instance.command({ action: "configure_auto" });
  expect(result.error).toBeDefined();
  expect(result.connection).toMatchObject({
    codexMode: "fixed",
    codexPath: exe,
  });
  expect(discoverCodex).not.toHaveBeenCalled();
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
      const model = provider === "claude" ? "claude-haiku-5-5" : "gpt-6-luna";
      return [
        {
          provider,
          model: provider === "claude" ? "haiku" : model,
          resolvedModel: provider === "claude" ? model : undefined,
          efforts: [null, "low", "medium"],
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
    expect(record.answer).toBe("answer from claude-haiku-5-5");
    expect(
      JSON.parse(record.calls[0]!.communication!.input.text).prompt.question,
    ).toBe("質問");
    expect(
      JSON.parse(record.calls[0]!.communication!.output!.text).summary,
    ).toBe(record.answer);
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
    /^質問先のモデル「gpt-6-luna」を利用できないか/,
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
  expect(view.error).toMatch(
    /^質問先のモデル「claude-haiku-5-5」を利用できないか/,
  );
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
function listAgent(
  provider: "claude" | "codex",
  list: { model: string; quotaAllowed?: boolean | null }[],
) {
  const calls = { discover: 0, run: 0, ran: [] as string[] };
  const agent: OfficialAgent = {
    provider,
    async discover() {
      calls.discover++;
      return list.map((m) => ({
        provider,
        model: m.model,
        resolvedModel: provider === "claude" ? m.model : undefined,
        efforts: [null, "low", "medium"],
        available: true,
        quotaAllowed: m.quotaAllowed === undefined ? true : m.quotaAllowed,
        capabilitySource:
          provider === "claude" ? "official-sdk" : "official-app-server",
      }));
    },
    async run(request) {
      calls.run++;
      calls.ran.push(request.model.model);
      return {
        status: "completed",
        dispatched: true,
        output: {
          summary: "ok",
          ...(JSON.stringify(request.outputSchema).includes('"intent"')
            ? { intent: "question" }
            : {}),
        },
        observedModels: [request.model.model],
        usage: null,
        elapsedMs: 1,
      };
    },
  };
  return { agent, calls };
}
const codexList = [
  { model: "gpt-6.1-sol" },
  { model: "gpt-6-astra" },
  { model: QUESTION_MODELS.codex },
];
const claudeList = [
  { model: "claude-opus-5-5" },
  { model: "claude-sonnet-5-5" },
  { model: QUESTION_MODELS.claude },
];
it("panel questions preserve their own history and exclude ordinary sessions across restart", async () => {
  const target = listAgent("claude", claudeList),
    prompts: AgentRequest[] = [];
  const run = target.agent.run;
  target.agent.run = async (r, s) => {
    prompts.push(r);
    return run(r, s);
  };
  const path = await home();
  const first = new OfficialWorkflowService({
    home: path,
    fake: false,
    agents: { claude: target.agent },
  });
  services.push(first);
  for (const sessionId of ["A", "B"])
    await first.submitSession(
      {
        sessionId,
        cwd: path,
        model: "claude:opus",
        effort: "high",
        text: `private-${sessionId}`,
        history: [],
      },
      new AbortController().signal,
    );
  await first.command({
    action: "chat",
    provider: "claude",
    text: "panel-first",
  });
  await wait(first, (v) => !v.activeId);
  expect(JSON.parse(prompts.at(-1)!.prompt).history).toEqual([]);
  await first.close();
  const restored = new OfficialWorkflowService({
    home: path,
    fake: false,
    agents: { claude: target.agent },
  });
  services.push(restored);
  await restored.command({
    action: "chat",
    provider: "claude",
    text: "panel-second",
  });
  await wait(restored, (v) => !v.activeId);
  expect(JSON.parse(prompts.at(-1)!.prompt).history).toEqual([
    { question: "panel-first", answer: "ok", workflowStatus: "completed" },
  ]);
  expect(prompts.at(-1)!.prompt).not.toContain("private-");
  // Original ordinary records are retained; only the outgoing history is filtered.
  expect(
    restored
      .view()
      .records.filter((r) => r.record.sessionId)
      .map((r) => r.record.goal)
      .sort(),
  ).toEqual(["private-A", "private-B"]);
});
it.each([
  ["codex", "listed last", codexList],
  ["codex", "listed first", [...codexList].reverse()],
  ["claude", "listed last", claudeList],
  ["claude", "listed first", [...claudeList].reverse()],
] as const)(
  "selects exactly the fixed %s question model regardless of list order (%s)",
  async (provider, _order, list) => {
    const target = listAgent(provider, [...list]),
      other = listAgent(provider === "claude" ? "codex" : "claude", []);
    const path = await home();
    const instance = new OfficialWorkflowService({
      home: path,
      fake: false,
      codexPath: "C:/configured/codex.exe",
      agents: { [provider]: target.agent, [other.agent.provider]: other.agent },
    });
    services.push(instance);
    await instance.command({ action: "chat", provider, text: "質問" });
    const view = await wait(instance, (v) => !v.activeId);
    expect(target.calls.ran).toEqual([QUESTION_MODELS[provider]]);
    // The recorded selection is the same value the panel displays.
    expect(view.records[0]!.record.calls[0]!.requestedModel).toBe(
      QUESTION_MODELS[provider],
    );
    expect(other.calls.discover).toBe(0);
  },
);
it.each([
  [
    "missing",
    codexList.filter((m) => m.model !== QUESTION_MODELS.codex),
    /一覧にありません/,
  ],
  [
    "listed but not usable",
    codexList.map((m) =>
      m.model === QUESTION_MODELS.codex ? { ...m, quotaAllowed: null } : m,
    ),
    /を利用できないか、通常枠を確認できません/,
  ],
] as const)(
  "stops when the fixed Codex question model is %s, without using another Codex model",
  async (_label, list, reason) => {
    const codex = listAgent("codex", [...list]);
    const path = await home();
    const instance = new OfficialWorkflowService({
      home: path,
      fake: false,
      codexPath: "C:/configured/codex.exe",
      agents: { codex: codex.agent },
    });
    services.push(instance);
    const view = await instance.command({
      action: "chat",
      provider: "codex",
      text: "質問",
    });
    expect(view.error).toMatch(/^質問先のモデル「gpt-6-luna」/);
    expect(view.error).toMatch(reason);
    expect(codex.calls.run).toBe(0);
  },
);
it("uses question models that exist and are enabled in the shipped catalog", () => {
  const catalog = loadModelCatalog();
  for (const provider of ["claude", "codex"] as const)
    expect(
      catalog.find((m) => m.id === QUESTION_MODELS[provider]),
    ).toMatchObject({ provider, enabled: true });
});
it("pins the managed Claude agent through discovery and a question, then uses the next version for the next task", async () => {
  const first = listAgent("claude", claudeList),
    second = listAgent("claude", claudeList);
  const factory = vi
    .fn()
    .mockReturnValueOnce(first.agent)
    .mockReturnValue(second.agent);
  const path = await home();
  const instance = new OfficialWorkflowService({
    home: path,
    fake: false,
    claudeRuntime: {
      agent: factory,
      view: () => ({ state: "ready", version: "0.3.291", message: "準備済み" }),
    },
  });
  services.push(instance);
  const request = {
    sessionId: "managed-session",
    effort: "high" as const,
    cwd: path,
    model: "claude:opus",
    text: "質問",
    history: [],
  };
  await instance.submitSession(request, new AbortController().signal);
  expect(factory).toHaveBeenCalledTimes(1);
  expect(first.calls).toMatchObject({ discover: 1, run: 1 });
  expect(second.calls).toMatchObject({ discover: 0, run: 0 });
  await instance.submitSession(request, new AbortController().signal);
  expect(factory).toHaveBeenCalledTimes(2);
  expect(second.calls).toMatchObject({ discover: 1, run: 1 });
  expect(instance.view().claudeRuntime?.version).toBe("0.3.291");
});

it.each(["claude", "codex"] as const)(
  "ordinary %s questions query once with their session's history, never planning or consulting the other company",
  async (provider) => {
    const target = listAgent(
        provider,
        provider === "claude" ? claudeList : codexList,
      ),
      other = listAgent(provider === "claude" ? "codex" : "claude", []);
    const prompts: AgentRequest[] = [],
      original = target.agent.run;
    target.agent.run = async (request, signal) => {
      prompts.push(request);
      return original(request, signal);
    };
    const path = await home(),
      instance = new OfficialWorkflowService({
        home: path,
        fake: false,
        codexPath: "C:/configured/codex.exe",
        agents: {
          [provider]: target.agent,
          [other.agent.provider]: other.agent,
        },
      });
    services.push(instance);
    const result = await instance.submitSession(
      {
        sessionId: "ordinary-session",
        cwd: path,
        model: provider === "claude" ? "claude:opus" : "codex:sol",
        effort: "high",
        text: "普通の質問",
        history: [{ role: "assistant", text: "この会話だけの文脈" }],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ summary: "ok", status: "completed" });
    expect(target.calls.ran).toEqual([QUESTION_MODELS[provider]]);
    expect(other.calls).toMatchObject({ discover: 0, run: 0 });
    expect(prompts[0]).toMatchObject({
      phase: "conversation",
      files: [],
      tests: [],
    });
    expect(JSON.parse(prompts[0]!.prompt).history).toEqual([
      { role: "assistant", text: "この会話だけの文脈" },
    ]);
    expect(instance.view().records[0]!.record).toMatchObject({
      sessionId: "ordinary-session",
      next: "complete",
    });
    expect(instance.view().records[0]!.record.calls).toHaveLength(1);
    const firstFacts = JSON.parse(prompts[0]!.prompt).executionFacts;
    expect(firstFacts.current).toMatchObject({
      sourceCwd: path,
      measuredHead: null,
    });
    expect(firstFacts.current.executionCwd).not.toBe(path);
    await instance.submitSession(
      {
        sessionId: "ordinary-session",
        cwd: path,
        model: provider === "claude" ? "claude:opus" : "codex:sol",
        effort: "high",
        text: "前の停止理由を説明して",
        history: [{ role: "assistant", text: "Gitなしなのでgit initが必要" }],
      },
      new AbortController().signal,
    );
    const nextFacts = JSON.parse(prompts[1]!.prompt).executionFacts;
    expect(nextFacts.recent).toHaveLength(1);
    expect(nextFacts.recent[0]).toMatchObject({
      sourceCwd: path,
      confirmedDispatches: 1,
      measuredHead: null,
    });
    expect(nextFacts.instruction).toContain(
      "Do not advise git init without evidence",
    );
  },
);
it("ordinary questions explicitly stop on unavailable official connection without switching company or another model", async () => {
  const target = listAgent("codex", [{ model: "gpt-6.1-sol" }]),
    other = listAgent("claude", claudeList),
    path = await home();
  const instance = new OfficialWorkflowService({
    home: path,
    fake: false,
    codexPath: "C:/configured/codex.exe",
    agents: { codex: target.agent, claude: other.agent },
  });
  services.push(instance);
  await expect(
    instance.submitSession(
      {
        sessionId: "ordinary-session",
        cwd: path,
        model: "codex:sol",
        effort: "high",
        text: "質問",
        history: [],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("一覧にありません");
  expect(target.calls.run).toBe(0);
  expect(other.calls).toMatchObject({ discover: 0, run: 0 });
});
it.each([
  [
    { intent: "work", summary: "対象とテストを確認してください" },
    "completed",
    true,
  ],
  [{ intent: "question", summary: "五" }, "completed", false],
  [{ summary: "missing intent" }, "failed", false],
  [{ intent: "maybe", summary: "unknown" }, "failed", false],
])(
  "ordinary input uses one read-only classifier and never infers permission: %j",
  async (output, status, taskRequired) => {
    const target = listAgent("claude", claudeList),
      requests: AgentRequest[] = [];
    target.agent.run = async (request) => {
      requests.push(request);
      expect(
        await request.approve(
          "dummy",
          {} as never,
          new AbortController().signal,
        ),
      ).toBe(false);
      return {
        status: "completed",
        dispatched: true,
        output,
        observedModels: [request.model.model],
        usage: null,
        elapsedMs: 1,
      };
    };
    const path = await home();
    const service = new OfficialWorkflowService({
      home: path,
      fake: false,
      agents: { claude: target.agent },
    });
    services.push(service);
    const result = await service.submitSession(
      {
        sessionId: "intent",
        cwd: path,
        model: "claude:opus",
        effort: "high",
        text: "合成依頼",
        history: [],
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status, taskRequired });
    if (status === "completed")
      expect(result.summary).toBe((output as { summary: string }).summary);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      phase: "conversation",
      files: [],
      tests: [],
      timeoutMs: 60000,
      model: { model: QUESTION_MODELS.claude },
    });
    const record = service.view().records[0]!.record;
    expect(record.plan).toBeUndefined();
    expect(record.commits).toEqual([]);
    expect(record.inputIntent).toBe(
      status === "completed"
        ? (output as { intent: string }).intent
        : undefined,
    );
  },
);
