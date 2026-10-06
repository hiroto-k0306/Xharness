import { afterEach, expect, it, vi } from "vitest";
import { rm, writeFile, readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createSyntheticWorkspace,
  fixtureAgents,
  fixtureWorkflowOptions,
  fixturePlan,
  fixtureModels,
  fixtureTest,
} from "./fixtures.js";
import {
  runOfficialSingleTask,
  resumeBlockReason,
  workflowUsage,
  type WorkflowRecord,
} from "./runtime.js";
import { validateOfficialPlan, type OfficialPlan } from "./contracts.js";
import { withSessionTrace, withTaskTrace } from "../../core/trace.js";
import { readTraceReplay } from "../../session/report-trace.js";
import { evaluateTrace } from "../../session/evaluation.js";
import { officialWorkflowReport } from "./report.js";
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
it.each([undefined, "", "Here is a plan", { summary: "Nothing", tasks: [] }])(
  "stops after one invalid plan without retrying or approving: %j",
  async (output) => {
    const cwd = await workspace(),
      fake = fixtureAgents(),
      approve = vi.fn(async () => true);
    const run = fake.agents.claude.run;
    fake.agents.claude.run = async (request, s) => ({
      ...(await run(request, s)),
      output,
    });
    const result = await runOfficialSingleTask(
      fixtureWorkflowOptions(cwd, { agents: fake.agents, approve }),
      signal(),
    );
    expect(result.status).toBe("failed");
    expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);
    expect(approve).not.toHaveBeenCalled();
    expect(result.commits).toEqual([]);
    expect(resumeBlockReason(result)).toBeTruthy();
  },
);
it("stops a no-change implementation without tests, review or replay", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents(),
    run = fake.agents.claude.run;
  let implementations = 0;
  fake.agents.claude.run = async (request, s) => {
    if (request.phase === "plan") return run(request, s);
    implementations++;
    return {
      status: "completed",
      dispatched: true,
      output: { summary: "No edits needed" },
      observedModels: [request.model.model],
      usage: null,
      elapsedMs: 1,
    };
  };
  const result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, { agents: fake.agents }),
    signal(),
  );
  expect(result).toMatchObject({
    status: "failed",
    error: "no-changes",
    checks: [],
    reviews: [],
    commits: [],
  });
  expect(implementations).toBe(1);
  expect(result.calls.map((c) => c.phase)).toEqual(["plan", "implement"]);
  expect(resumeBlockReason(result)).toBe("phase-not-checkpointed");
});
it("preserves a concrete provider stop reason in the record and HTML", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents();
  const error =
    "使用量の再取得に失敗しました。枠切れとは断定せず停止しました。";
  fake.agents.claude.run = async () => ({
    status: "quota-paused",
    dispatched: false,
    observedModels: [],
    usage: null,
    elapsedMs: 1,
    error,
  });
  const result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, { agents: fake.agents }),
    signal(),
  );
  expect(result.status).toBe("quota-paused");
  expect(result.error).toBe(error);
  expect(officialWorkflowReport(result)).toContain(error);
});
it.each(["verify", "review"] as const)(
  "resumes %s checkpoint without replaying completed model work",
  async (next) => {
    const cwd = await workspace();
    let checkpoint: WorkflowRecord | undefined;
    await expect(
      runOfficialSingleTask(
        fixtureWorkflowOptions(cwd, {
          save: async (record) => {
            if (
              record.next === next &&
              !record.pendingEffect &&
              record.calls.at(-1)?.phase !== "review"
            ) {
              checkpoint = structuredClone(record);
              throw new Error("fixture process interruption");
            }
          },
        }),
        signal(),
      ),
    ).rejects.toThrow();
    expect(checkpoint).toBeDefined();
    expect(resumeBlockReason(checkpoint!)).toBeNull();
    const fake = fixtureAgents();
    const resumed = await runOfficialSingleTask(
      fixtureWorkflowOptions(cwd, { resume: checkpoint, agents: fake.agents }),
      signal(),
    );
    expect(resumed.status).toBe("completed");
    expect(fake.requests.map((r) => r.phase)).toEqual([
      "review",
      "fix",
      "review",
    ]);
    expect(resumed.calls.filter((c) => c.phase === "implement")).toHaveLength(
      1,
    );
    const changed = fixtureWorkflowOptions(cwd, {
      resume: { ...checkpoint!, head: resumed.head },
      tests: [{ ...fixtureTest(), args: ["forged-command"] }],
    });
    await expect(runOfficialSingleTask(changed, signal())).rejects.toThrow(
      "execution-scope-changed",
    );
  },
);
it.each(["claude", "codex"] as const)(
  "runs %s implementation, other-provider full review, correction and process evidence",
  async (implementation) => {
    const cwd = await workspace(),
      fake = fixtureAgents(implementation),
      saved: WorkflowRecord[] = [];
    const result = await runOfficialSingleTask(
      fixtureWorkflowOptions(cwd, {
        agents: fake.agents,
        save: async (r) => {
          saved.push(structuredClone(r));
        },
      }),
      signal(),
    );
    expect(result.status).toBe("completed");
    expect(result.correctionRounds).toBe(1);
    expect(fake.requests[0]!.outputSchema).toMatchObject({
      properties: {
        tasks: {
          items: {
            properties: {
              acceptance: { items: { type: "string", enum: ["arithmetic"] } },
            },
          },
        },
      },
    });
    expect(result.commits).toHaveLength(2);
    expect(result.checks.map((r) => r.tests[0]?.passed)).toEqual([false, true]);
    expect(fake.requests.map((r) => [r.phase, r.model.provider])).toEqual([
      ["plan", "claude"],
      ["implement", implementation],
      ["review", implementation === "claude" ? "codex" : "claude"],
      ["fix", implementation],
      ["review", implementation === "claude" ? "codex" : "claude"],
    ]);
    const review = JSON.parse(fake.requests[2]!.prompt);
    expect(review.completeDiff).toContain("intentionally incorrect");
    expect(review.head).toBe(result.commits[0]);
    expect(saved.some((r) => r.calls.some((c) => c.status === "running"))).toBe(
      true,
    );
    expect(workflowUsage(result)).toMatchObject({
      dispatchedCalls: 5,
      completeUsageCalls: 5,
      input: { known: 70 },
      output: { known: 10 },
      reasoning: { known: null, measuredCalls: 0 },
      cacheWrite: { known: 3, measuredCalls: 3 },
    });
    for (const call of result.calls) {
      if ("usage" in call && call.usage)
        expect(call.usage.measurement.provider).toBe(call.provider);
    }
    const html = officialWorkflowReport(result);
    expect(html).toContain("模擬実行");
    expect(html).toContain("プロセスで確認");
    expect(html).not.toContain("<script");
  },
);
it("shares X task identity and native usage with existing evaluation trace", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents("claude", false),
    id = randomUUID();
  const home = await mkdtemp(join(tmpdir(), "xh-official-trace-"));
  homes.push(home);
  const result = await withSessionTrace(
    home,
    id,
    (s) => s,
    () =>
      withTaskTrace({ model: "fixture-opus", taskId: id }, async () => {
        const record = await runOfficialSingleTask(
          fixtureWorkflowOptions(cwd, { id, agents: fake.agents }),
          signal(),
        );
        return {
          stopCause:
            record.status === "completed"
              ? "workflow_complete"
              : "review_attention",
          record,
        };
      }),
  );
  expect(result.record.status).toBe("completed");
  const replay = await readTraceReplay(home, id, (s) => s);
  const task = evaluateTrace(replay ?? undefined)[0]!;
  expect(task.taskId).toBe(id);
  expect(task.calls).toHaveLength(3);
  expect(task.metrics.input.known).toBe(42);
  expect(task.evidence.some((e) => e.source === "configured_check")).toBe(true);
  expect(task.evidence.some((e) => e.source === "model_review")).toBe(true);
  expect(task.reviewAttempts).toBe(1);
  expect(task.outcome).toBe("completed");
});
it("does not implement a rejected plan or a plan approval that changes the baseline", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents();
  let result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, {
      agents: fake.agents,
      approve: async () => false,
    }),
    signal(),
  );
  expect(result.status).toBe("cancelled");
  expect(fake.requests).toHaveLength(1);
  result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, {
      approve: async () => {
        await writeFile(join(cwd, "add.mjs"), "user edit");
        return true;
      },
    }),
    signal(),
  );
  expect(result.error).toBe("workspace-changed");
  expect(result.commits).toHaveLength(0);
  expect(await readFile(join(cwd, "add.mjs"), "utf8")).toBe("user edit");
});
it("stops before any model call for dirty workspace or an unavailable cross-provider reviewer", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents();
  const result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, {
      agents: fake.agents,
      models: fixtureModels.map((m) =>
        m.provider === "codex" ? { ...m, quotaAllowed: null } : m,
      ),
    }),
    signal(),
  );
  expect(result.error).toBe("reviewer-unavailable");
  expect(fake.requests).toHaveLength(0);
  await writeFile(join(cwd, "user.txt"), "preserve");
  await expect(
    runOfficialSingleTask(fixtureWorkflowOptions(cwd), signal()),
  ).rejects.toMatchObject({ code: "dirty-workspace" });
});
it("caps correction cycles at two and does not accept model claims as test evidence", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents("claude", false);
  let count = 0;
  const implement = fake.agents.claude.run;
  fake.agents.claude.run = async (request, s) => {
    const result = await implement(request, s);
    if (request.phase !== "plan")
      await writeFile(
        join(cwd, "add.mjs"),
        `export const add=(a,b)=>a-b; // ${count++}\n`,
      );
    return result;
  };
  const result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, { agents: fake.agents }),
    signal(),
  );
  expect(result.status).toBe("attention");
  expect(result.correctionRounds).toBe(2);
  expect(result.reviews).toHaveLength(3);
  expect(result.checks.every((r) => !r.tests[0]?.passed)).toBe(true);
});
it("preserves partial changes and stops on failures or cancellation without replay", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents("claude", false),
    run = fake.agents.claude.run;
  fake.agents.claude.run = async (request, s) => {
    const result = await run(request, s);
    return request.phase === "implement"
      ? { ...result, status: "quota-paused", usage: null }
      : result;
  };
  const result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd, { agents: fake.agents }),
    signal(),
  );
  expect(result.status).toBe("quota-paused");
  expect(result.calls).toHaveLength(2);
  expect(result.commits).toHaveLength(0);
  expect(await readFile(join(cwd, "add.mjs"), "utf8")).toContain("a+b");
});
it("fails before inference when the durable running intent cannot be stored", async () => {
  const cwd = await workspace(),
    fake = fixtureAgents(),
    save = vi.fn(async (r: WorkflowRecord) => {
      if (r.calls.length) throw new Error("disk unavailable");
    });
  await expect(
    runOfficialSingleTask(
      fixtureWorkflowOptions(cwd, { agents: fake.agents, save }),
      signal(),
    ),
  ).rejects.toThrow("disk unavailable");
  expect(fake.requests).toHaveLength(0);
});
it.each([
  [
    "scope-expansion",
    (p: OfficialPlan) => {
      p.tasks[0]!.files = ["other.mjs"];
    },
  ],
  [
    "unapproved-test",
    (p: OfficialPlan) => {
      p.tasks[0]!.acceptance = ["model-says-pass"];
    },
  ],
  [
    "unavailable-model",
    (p: OfficialPlan) => {
      p.tasks[0]!.assignee.model = "invented";
    },
  ],
  [
    "unknown-dependency",
    (p: OfficialPlan) => {
      p.tasks[0]!.dependsOn = ["missing"];
    },
  ],
  [
    "dependency-cycle",
    (p: OfficialPlan) => {
      p.tasks[0]!.dependsOn = ["arithmetic"];
    },
  ],
  [
    "file-conflict",
    (p: OfficialPlan) => {
      p.tasks.push({ ...structuredClone(p.tasks[0]!), id: "second" });
    },
  ],
] as const)("validates untrusted plan: %s", (code, mutate) => {
  const plan = fixturePlan();
  mutate(plan);
  expect(() =>
    validateOfficialPlan(plan, fixtureModels, ["add.mjs"], [fixtureTest()]),
  ).toThrow(code);
});
