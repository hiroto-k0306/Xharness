import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { runtimeEnvironment } from "./workspace.js";
import { rm } from "node:fs/promises";
import {
  loadCatalog,
  overrideCatalogForTest,
  resolveModelPolicy,
  type Catalog,
} from "../../config/catalog.js";
import {
  createSyntheticWorkspace,
  fixtureAgents,
  fixturePlan,
  fixtureWorkflowOptions,
} from "./fixtures.js";
import {
  runOfficialSingleTask,
  approvalDigest,
  type WorkflowRecord,
  type WorkflowOptions,
} from "./runtime.js";
import {
  resolveCallSelection,
  policyCandidate,
  validateSavedModelSelections,
  type ResolveCallModel,
} from "./model-selection.js";
import type { ModelCandidate } from "./contracts.js";
const homes: string[] = [];
afterEach(async () => {
  overrideCatalogForTest(undefined);
  for (const cwd of homes.splice(0))
    await rm(cwd, { recursive: true, force: true });
});
const signal = () => new AbortController().signal;
const candidate = (
  provider: "claude" | "codex",
  model: string,
): ModelCandidate => ({
  provider,
  model,
  resolvedModel: model,
  available: true,
  quotaAllowed: true,
  efforts: [null, "low", "high"],
  capabilitySource:
    provider === "claude" ? "official-sdk" : "official-app-server",
});
const resolver: ResolveCallModel = async (policy) => {
  const resolved = resolveModelPolicy(
    `${policy.provider}:${policy.model}`,
    policy.effort,
  );
  return {
    model: candidate(policy.provider, resolved.id),
    catalog: resolved.catalog,
  };
};
const changedCatalog = (before: Catalog) => {
  const next = structuredClone(before);
  const sol = next.models.find((m) => m.alias === "sol")!;
  const old = sol.id;
  sol.id = "gpt-next-explicit";
  sol.historicalIds = [...(sol.historicalIds ?? []), old];
  next.version++;
  next.digest = "b".repeat(64);
  return next;
};
const record = (): WorkflowRecord => ({
  version: 1,
  id: "fixture",
  simulated: true,
  goal: "test",
  cwd: "/tmp",
  startedAt: "2026-10-09",
  status: "interrupted",
  next: "fix",
  base: "base",
  head: "head",
  correctionRounds: 1,
  calls: [],
  tools: [],
  checks: [],
  reviews: [],
  commits: [],
});

it("resolves each new call with frozen actual evidence and records previous implementation for fix", async () => {
  const before = structuredClone(loadCatalog());
  const r = record();
  const old = before.models.find((m) => m.alias === "sol")!.id;
  const first = await resolveCallSelection(
    { resolveCallModel: resolver },
    r,
    "implement",
    candidate("codex", old),
    "low",
    signal(),
  );
  r.calls.push({
    requestId: "first",
    phase: "implement",
    provider: "codex",
    requestedModel: first.model.model,
    effort: first.effort,
    status: "running",
    modelSelection: first.modelSelection,
  });
  const saved = structuredClone(r.calls);
  overrideCatalogForTest(changedCatalog(before));
  const next = await resolveCallSelection(
    { resolveCallModel: resolver },
    r,
    "fix",
    candidate("codex", old),
    "low",
    signal(),
  );
  expect(next.model.model).toBe("gpt-next-explicit");
  expect(next.modelSelection).toMatchObject({
    policy: { model: "sol", effort: "low" },
    changed: true,
    previous: { model: old, effort: "low" },
    resolved: {
      model: "gpt-next-explicit",
      catalog: { version: before.version + 1 },
    },
  });
  expect(r.calls).toEqual(saved);
  expect(first.model.model).toBe(old);
  expect(first.modelSelection?.resolved.catalog.version).toBe(before.version);
});
it("accepts declared historic IDs with a matching saved policy, and stops unknown IDs/family changes", async () => {
  const r = record();
  r.plan = fixturePlan("codex");
  const task = r.plan.tasks[0]!;
  task.assignee.model = "gpt-6-sol";
  task.assignee.effort = "low";
  r.modelPolicies = {
    tasks: {
      [task.id]: {
        assignee: { provider: "codex", model: "sol", effort: "low" },
      },
    },
  };
  const original = structuredClone(r);
  const options = {
    models: [],
    resolveCallModel: resolver,
  } as unknown as WorkflowOptions;
  expect(
    (
      await policyCandidate(
        options,
        r,
        "codex",
        task.assignee.model,
        "low",
        signal(),
      )
    )?.model,
  ).toBe("gpt-6-sol");
  expect(r).toEqual(original);
  expect(approvalDigest(r)).toBe(approvalDigest(original));
  task.assignee.model = "unlisted-old-generation";
  await expect(
    policyCandidate(options, r, "codex", task.assignee.model, "low", signal()),
  ).rejects.toThrow(/明示されたalias対応/);
  expect(() => validateSavedModelSelections(r)).not.toThrow(); // unknown IDs are still readable
  task.assignee.model = "gpt-6-sol";
  r.modelPolicies.tasks![task.id]!.assignee.model = "astra";
  await expect(
    policyCandidate(options, r, "codex", task.assignee.model, "low", signal()),
  ).rejects.toThrow("model-policy-family-changed");
});
it.each(["quota", "effort", "provider"] as const)(
  "stops %s mismatch before recording/sending a call",
  async (kind) => {
    const r = record();
    const send = vi.fn(async (policy) => {
      const resolved = await resolver(policy, signal());
      if (kind === "quota") resolved.model.quotaAllowed = null;
      if (kind === "effort") resolved.model.efforts = [null];
      if (kind === "provider") resolved.model.provider = "claude";
      return resolved;
    });
    await expect(
      resolveCallSelection(
        { resolveCallModel: send },
        r,
        "implement",
        candidate("codex", "gpt-6.1-sol"),
        "low",
        signal(),
      ),
    ).rejects.toThrow("unavailable-model");
    expect(r.calls).toEqual([]);
  },
);
it("keeps the approved plan/digest and executes latest aliases after approval and between review/fix", async () => {
  const cwd = await createSyntheticWorkspace();
  homes.push(cwd);
  const before = structuredClone(loadCatalog());
  const fake = fixtureAgents("codex");
  const plan = fixturePlan("codex");
  const task = plan.tasks[0]!;
  task.assignee.model = "gpt-6.1-sol";
  task.assignee.effort = "low";
  task.reviewer!.model = "claude-opus-5-5";
  task.reviewer!.effort = "high";
  const run = fake.agents.claude.run;
  let reviews = 0;
  fake.agents.claude.run = async (request, s) => {
    const result = await run(request, s);
    if (request.phase === "review" && reviews++ === 0) {
      const next = changedCatalog(structuredClone(loadCatalog()));
      next.models.find((m) => m.alias === "sol")!.id =
        "gpt-after-review-explicit";
      overrideCatalogForTest(next);
    }
    return request.phase === "plan"
      ? { ...result, output: structuredClone(plan) }
      : result;
  };
  let approved = "";
  const options = fixtureWorkflowOptions(cwd, {
    agents: fake.agents,
    models: [
      candidate("claude", "claude-opus-5-5"),
      candidate("codex", "gpt-6.1-sol"),
    ],
    planner: { provider: "claude", model: "claude-opus-5-5", effort: "high" },
    resolveCallModel: resolver,
    approve: async (_plan, digest) => {
      approved = digest;
      overrideCatalogForTest(changedCatalog(before));
      return true;
    },
  });
  // Exercise state transitions with a real fixed Node test, independently of
  // Windows Job containment (the production Linux port deliberately refuses).
  if (process.platform !== "win32")
    options.workspace.test = (spec, abort) =>
      new Promise((done) => {
        const started = Date.now();
        execFile(
          process.execPath,
          ["--test", "acceptance.test.mjs"],
          {
            cwd,
            signal: abort,
            shell: false,
            timeout: spec.timeoutMs,
            maxBuffer: 30000,
            env: runtimeEnvironment(),
          },
          (error, stdout, stderr) => {
            const exitCode = error
              ? typeof error.code === "number"
                ? error.code
                : null
              : 0;
            done({
              id: spec.id,
              exitCode,
              passed: exitCode === 0 && !abort.aborted,
              elapsedMs: Date.now() - started,
              output: `${stdout}${stderr}`.slice(0, 30000),
              source: "process",
            });
          },
        );
      });
  const result = await runOfficialSingleTask(options, signal());
  expect(result.status).toBe("completed");
  expect(result.plan).toEqual(plan);
  expect(result.approvedDigest).toBe(approved);
  expect(approvalDigest(result)).toBe(approved);
  expect(result.modelPolicies?.tasks?.[task.id]?.assignee.model).toBe("sol");
  expect(
    fake.requests
      .filter((r) => r.phase === "implement" || r.phase === "fix")
      .map((r) => r.model.model),
  ).toEqual(["gpt-next-explicit", "gpt-after-review-explicit"]);
  expect(
    result.calls
      .filter((c) => c.phase === "review")
      .every((c) => c.provider === "claude"),
  ).toBe(true);
});

it("rejects inconsistent saved effort and keeps safe late policy failure reasons", async () => {
  const r = record();
  r.plan = fixturePlan("codex");
  const task = r.plan.tasks[0]!;
  task.assignee.model = "gpt-6.1-sol";
  task.assignee.effort = "low";
  r.modelPolicies = {
    tasks: {
      [task.id]: {
        assignee: { provider: "codex", model: "sol", effort: "high" },
      },
    },
  };
  await expect(
    resolveCallSelection(
      { resolveCallModel: resolver },
      r,
      "fix",
      candidate("codex", task.assignee.model),
      "low",
      signal(),
    ),
  ).rejects.toThrow("model-policy-effort-changed");
  delete r.modelPolicies;
  await expect(
    resolveCallSelection(
      {
        resolveCallModel: async () => {
          throw new Error(
            "モデルalias「sol」のeffort「low」は対応していません。",
          );
        },
      },
      r,
      "fix",
      candidate("codex", task.assignee.model),
      "low",
      signal(),
    ),
  ).rejects.toThrow("モデルalias「sol」のeffort「low」は対応していません。");
  await expect(
    resolveCallSelection(
      {
        resolveCallModel: async () => {
          throw new Error("unknown raw secret");
        },
      },
      r,
      "fix",
      candidate("codex", task.assignee.model),
      "low",
      signal(),
    ),
  ).rejects.toThrow("モデルのalias/利用枠/effortを解決できません");
  expect(r.calls).toEqual([]);
});

it("rejects malformed persisted selection evidence without reinterpreting valid old IDs", () => {
  const r = record();
  r.modelPolicies = {
    planner: { provider: "codex", model: "unknown-historic-alias" },
  };
  expect(() => validateSavedModelSelections(r)).not.toThrow();
  r.calls.push({
    requestId: "old",
    phase: "plan",
    provider: "codex",
    requestedModel: "historic-model",
    effort: null,
    status: "running",
    modelSelection: {
      policy: { provider: "codex", model: "sol" },
      resolved: null,
    } as never,
  });
  expect(() => validateSavedModelSelections(r)).toThrow();
});
it("resolves model availability in the isolated call record cwd, including plan checks", async () => {
  const r = record();
  r.cwd = "/tmp/owned-node";
  const resolve = vi.fn<ResolveCallModel>(async (policy, signal, cwd) => {
    expect(cwd).toBe(r.cwd);
    return resolver(policy, signal, cwd);
  });
  const model = candidate("codex", resolveModelPolicy("codex:sol").id);
  await policyCandidate(
    { ...fixtureWorkflowOptions(r.cwd), resolveCallModel: resolve, models: [] },
    r,
    "codex",
    model.model,
    "low",
    signal(),
  );
  await resolveCallSelection(
    { resolveCallModel: resolve },
    r,
    "implement",
    model,
    "low",
    signal(),
  );
  expect(resolve).toHaveBeenCalledTimes(2);
});
