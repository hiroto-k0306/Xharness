import { afterEach, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import {
  createSyntheticWorkspace,
  fixtureAgents,
  fixtureModels,
  fixturePlan,
  fixtureTest,
  fixtureWorkflowOptions,
} from "./fixtures.js";
import { runOfficialSingleTask, type WorkflowRecord } from "./runtime.js";
import { validateOfficialPlan, type ModelCandidate } from "./contracts.js";
import { resolvePlannerChoice } from "./service.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
});
const workspace = async () => {
  const cwd = await createSyntheticWorkspace();
  homes.push(cwd);
  return cwd;
};
const signal = () => new AbortController().signal;
const files = ["add.mjs"],
  tests = [fixtureTest()];

it("requires a different-company reviewer for new plans and keeps older plans readable", () => {
  const plan = fixturePlan("claude");
  expect(
    validateOfficialPlan(plan, fixtureModels, files, tests, false, true)
      .tasks[0]!.reviewer,
  ).toMatchObject({ provider: "codex", model: "fixture-codex" });
  const same = structuredClone(plan);
  same.tasks[0]!.reviewer = {
    provider: "claude",
    model: "fixture-opus",
    effort: "high",
    reason: "same company",
  };
  expect(() =>
    validateOfficialPlan(same, fixtureModels, files, tests, false, true),
  ).toThrow("reviewer-same-provider");
  const unknown = structuredClone(plan);
  unknown.tasks[0]!.reviewer!.model = "not-offered";
  expect(() =>
    validateOfficialPlan(unknown, fixtureModels, files, tests, false, true),
  ).toThrow("unavailable-model");
  const legacy = structuredClone(plan);
  delete legacy.tasks[0]!.reviewer;
  expect(() =>
    validateOfficialPlan(legacy, fixtureModels, files, tests, false, true),
  ).toThrow("reviewer-missing");
  // A stored plan from before this field still validates when resumed.
  expect(
    validateOfficialPlan(legacy, fixtureModels, files, tests).tasks[0]!
      .reviewer,
  ).toBeUndefined();
});

const official: ModelCandidate[] = [
  {
    provider: "claude",
    model: "claude-opus-5-5",
    resolvedModel: "claude-opus-5-5",
    efforts: [null, "high"],
    available: true,
    quotaAllowed: true,
    capabilitySource: "official-sdk",
  },
  {
    provider: "claude",
    model: "claude-sonnet-5-5",
    resolvedModel: "claude-sonnet-5-5",
    efforts: [null, "high"],
    available: true,
    quotaAllowed: true,
    capabilitySource: "official-sdk",
  },
  {
    provider: "codex",
    model: "gpt-6.1-sol",
    efforts: [null, "low", "high"],
    available: true,
    quotaAllowed: true,
    capabilitySource: "official-app-server",
  },
];
it("resolves the main model to its own official connection without substituting", () => {
  expect(
    resolvePlannerChoice({ model: "claude:sonnet", effort: "high" }, official),
  ).toEqual({
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "high",
    selectedAs: "claude:sonnet",
    catalog: expect.objectContaining({ digest: expect.any(String) }),
  });
  expect(
    resolvePlannerChoice(
      { model: "codex:gpt-6.1-sol", effort: "high" },
      official,
    ),
  ).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
  // Unavailable on its connection: stop with the reason, never pick Opus instead.
  expect(() =>
    resolvePlannerChoice({ model: "claude:haiku", effort: null }, official),
  ).toThrow(/^計画モデル「claude-haiku-5-5」は公式Claude SDKで利用できない/);
  expect(() =>
    resolvePlannerChoice({ model: "codex:sol", effort: "max" }, official),
  ).toThrow(/推論レベル「max」に対応していません/);
  expect(() =>
    resolvePlannerChoice({ model: "claude:gpt-6.1-sol" }, official),
  ).toThrow(/明示されたalias対応/);
  const paused = official.map((m) => ({ ...m, quotaAllowed: null }));
  expect(() =>
    resolvePlannerChoice({ model: "claude:opus", effort: "high" }, paused),
  ).toThrow(/通常枠を確認できません/);
  // A recorded planner is resolved by its exact ID, independent of the current selection.
  expect(
    resolvePlannerChoice(
      {
        provider: "codex",
        model: "gpt-6.1-sol",
        effort: "high",
        selectedAs: "codex:sol",
      },
      official,
    ),
  ).toMatchObject({
    provider: "codex",
    model: "gpt-6.1-sol",
    selectedAs: "codex:sol",
  });
});

it("plans with a Codex main model through the same validation and approval, and records it", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents("claude"),
    approve = vi.fn(async () => true);
  const result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, {
      agents: fake.agents,
      approve,
      planner: {
        provider: "codex",
        model: "fixture-codex",
        effort: "low",
        selectedAs: "codex:fixture-codex",
      },
    }),
    signal(),
  );
  expect(result.status).toBe("completed");
  const plan = fake.requests.find((r) => r.phase === "plan")!;
  expect(plan.model).toMatchObject({
    provider: "codex",
    model: "fixture-codex",
  });
  expect(approve).toHaveBeenCalledTimes(1);
  expect(result.planner).toEqual({
    provider: "codex",
    model: "fixture-codex",
    effort: "low",
    selectedAs: "codex:fixture-codex",
  });
  // The plan's reviewer (another company than the Claude implementer) reviews.
  const reviews = fake.requests.filter((r) => r.phase === "review");
  expect(reviews.length).toBeGreaterThan(0);
  expect(reviews.every((r) => r.model.provider === "codex")).toBe(true);
});

it.each([undefined, { summary: "Nothing", tasks: [] }, "not a plan"])(
  "stops a Codex planner after one empty or invalid answer without retrying: %j",
  async (output) => {
    const cwd = await workspace(),
      fake = fixtureAgents("claude"),
      approve = vi.fn(async () => true);
    const run = fake.agents.codex.run;
    fake.agents.codex.run = async (request, s) =>
      request.phase === "plan"
        ? { ...(await run(request, s)), output }
        : run(request, s);
    const result = await runOfficialSingleTask(
      fixtureWorkflowOptions(cwd, {
        agents: fake.agents,
        approve,
        planner: { provider: "codex", model: "fixture-codex", effort: "low" },
      }),
      signal(),
    );
    expect(result.status).toBe("failed");
    expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);
    expect(approve).not.toHaveBeenCalled();
  },
);

it("rejects a new plan without a reviewer and uses configured reviewers only for older records", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents("claude");
  const run = fake.agents.claude.run;
  fake.agents.claude.run = async (request, s) => {
    const result = await run(request, s);
    if (request.phase !== "plan") return result;
    const plan = structuredClone(result.output) as ReturnType<
      typeof fixturePlan
    >;
    delete plan.tasks[0]!.reviewer;
    return { ...result, output: plan };
  };
  const fresh = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, { agents: fake.agents }),
    signal(),
  );
  expect(fresh.status).toBe("failed");
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);

  // An older record (approved plan without reviewer/planner) resumes unchanged.
  const legacyCwd = await workspace();
  let checkpoint: WorkflowRecord | undefined;
  await expect(
    runOfficialSingleTask(
      fixtureWorkflowOptions(legacyCwd, {
        save: async (record) => {
          if (record.next === "implement" && record.approvedDigest) {
            checkpoint = structuredClone(record);
            throw new Error("fixture process interruption");
          }
        },
      }),
      signal(),
    ),
  ).rejects.toThrow();
  delete checkpoint!.planner;
  delete checkpoint!.plan!.tasks[0]!.reviewer;
  const { digest } = await import("./runtime.js");
  checkpoint!.approvedDigest = digest(checkpoint!.plan);
  const resumedAgents = fixtureAgents("claude");
  const resumed = await runOfficialSingleTask(
    fixtureWorkflowOptions(legacyCwd, {
      resume: checkpoint,
      agents: resumedAgents.agents,
    }),
    signal(),
  );
  expect(resumed.planner).toBeUndefined();
  expect(
    resumedAgents.requests
      .filter((r) => r.phase === "review")
      .every((r) => r.model.model === "fixture-codex"),
  ).toBe(true);
});
