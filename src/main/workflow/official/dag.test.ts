import { it, expect, afterEach } from "vitest";
import { rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createDagWorkspace,
  dagAgents,
  dagPlan,
  dagWorkflowOptions,
  dagTests,
} from "./dag-fixtures.js";
import { runOfficialDag, dagResumeBlockReason } from "./dag.js";
import { fixtureModels } from "./fixtures.js";
import { validateOfficialPlan } from "./contracts.js";
import { gitWorkspace } from "./workspace.js";
import { OfficialWorktrees } from "./worktrees.js";
import type { WorkflowRecord } from "./runtime.js";
import { workflowUsage } from "./runtime.js";
import { withSessionTrace, withTaskTrace } from "../../core/trace.js";
import { readTraceReplay } from "../../session/report-trace.js";
import { evaluateTrace } from "../../session/evaluation.js";
// Acceptance subprocesses require the Windows Job supervisor (pwsh).
const test = it.skipIf(process.platform !== "win32");
const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 10 });
});
const fixture = async () => {
  const created = await createDagWorkspace();
  homes.push(created.owned);
  return created;
};
const signal = () => new AbortController().signal;
it("refuses a non-simulated DAG before any process or provider starts", async () => {
  await expect(
    runOfficialDag(
      dagWorkflowOptions(".", ".", { simulated: false }),
      signal(),
    ),
  ).rejects.toThrow("native-dag-not-enabled");
});
test("corrects an explicit synthetic integration review finding and rechecks both providers", async () => {
  const { owned, cwd } = await fixture(),
    fake = dagAgents(undefined, false);
  let first = true;
  const agents = {
    ...fake.agents,
    claude: {
      ...fake.agents.claude,
      run: async (
        request: Parameters<typeof fake.agents.claude.run>[0],
        s: AbortSignal,
      ) => {
        const result = await fake.agents.claude.run(request, s),
          input = JSON.parse(request.prompt);
        if (
          first &&
          input.role === "read-only cross-provider DAG integration review"
        ) {
          first = false;
          return {
            ...result,
            output: {
              base: input.base,
              head: input.head,
              findings: [
                {
                  severity: "must",
                  file: "combine.mjs",
                  line: 1,
                  message: "Synthetic integration correction",
                  evidence:
                    "Offline fixture exercises the explicit review correction boundary.",
                },
              ],
            },
          };
        }
        return result;
      },
    },
  };
  const record = await runOfficialDag(
    dagWorkflowOptions(cwd, owned, { agents }),
    signal(),
  );
  expect(record.status).toBe("completed");
  expect(record.correctionRounds).toBe(1);
  expect(
    fake.requests
      .filter((r) => r.phase === "fix")
      .map((r) => JSON.parse(r.prompt).task.id),
  ).toEqual(["integration"]);
  expect(record.dag!.integration!.checks).toHaveLength(2);
  const finalHead = record.head;
  expect(
    record.dag!.integration!.reviews.filter((r) => r.head === finalHead),
  ).toHaveLength(2);
  expect(record.commits).toHaveLength(4);
  // Four real Git commits/worktree imports plus integration correction and
  // both-provider rechecks: Windows standalone already took 28.22s (30s limit).
}, 60000);
it("runs independent tasks in parallel, depends on confirmed imports and globally cross-reviews", async () => {
  const { owned, cwd } = await fixture(),
    fake = dagAgents();
  const id = "dag-fixture";
  const record = await withSessionTrace(
    owned,
    id,
    (s) => s,
    () =>
      withTaskTrace({ taskId: id, model: "fixture-opus" }, async () => {
        const value = await runOfficialDag(
          dagWorkflowOptions(cwd, owned, { id, agents: fake.agents }),
          signal(),
        );
        return {
          ...value,
          stopCause:
            value.status === "completed"
              ? "workflow_complete"
              : "review_attention",
        };
      }),
  );
  const evaluation = evaluateTrace(
    (await readTraceReplay(owned, id, (s) => s)) ?? undefined,
  )[0]!;
  expect(evaluation.taskId).toBe(id);
  expect(evaluation.calls).toHaveLength(record.calls.length);
  expect(evaluation.metrics.input.known).toBe(
    workflowUsage(record).input.known,
  );
  expect(evaluation.correctionRounds).toBe(record.correctionRounds);
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(fake.maxActive).toBe(2);
  expect(record.dag!.nodes.map((n) => n.state)).toEqual([
    "integrated",
    "integrated",
    "integrated",
  ]);
  const [a, b, c] = record.dag!.nodes;
  expect(a!.base).toBe(b!.base);
  expect(c!.base).toBe(b!.integratedHead);
  expect(a!.record!.correctionRounds).toBe(1);
  expect(
    record.dag!.integration!.checks.at(-1)!.tests.every((t) => t.passed),
  ).toBe(true);
  expect(
    record.calls
      .filter((c) => c.nodeId === "integration" && c.phase === "review")
      .map((c) => c.provider),
  ).toEqual(["codex", "claude"]);
  expect(record.calls.every((c) => c.status !== "running")).toBe(true);
}, 30000);
it("serializes file conflicts and rejects missing dependencies, cycles, scopes and model candidates", () => {
  const plan = dagPlan();
  plan.tasks[1]!.files = ["add.mjs"];
  const validated = validateOfficialPlan(
    plan,
    fixtureModels,
    ["add.mjs", "multiply.mjs", "combine.mjs"],
    dagTests(),
    true,
  );
  expect(validated.tasks[1]!.dependsOn).toContain("add");
  for (const mutate of [
    (p: typeof plan) => {
      p.tasks[0]!.dependsOn = ["absent"];
    },
    (p: typeof plan) => {
      p.tasks[0]!.dependsOn = ["combine"];
    },
    (p: typeof plan) => {
      p.tasks[0]!.files = ["../outside"];
    },
    (p: typeof plan) => {
      p.tasks[0]!.assignee.model = "invented";
    },
  ]) {
    const invalid = dagPlan();
    mutate(invalid);
    expect(() =>
      validateOfficialPlan(
        invalid,
        fixtureModels,
        ["add.mjs", "multiply.mjs", "combine.mjs"],
        dagTests(),
        true,
      ),
    ).toThrow();
  }
});
it("runs conflicting writers sequentially from the imported predecessor", async () => {
  const { owned, cwd } = await fixture(),
    plan = dagPlan();
  plan.tasks = [
    plan.tasks[0]!,
    { ...plan.tasks[0]!, id: "add-again", title: "Second add writer" },
  ];
  const fake = dagAgents(plan, false);
  const record = await runOfficialDag(
    dagWorkflowOptions(cwd, owned, {
      agents: fake.agents,
      files: ["add.mjs"],
      tests: [dagTests()[0]!],
    }),
    signal(),
  );
  expect(record.status).toBe("completed");
  expect(fake.maxActive).toBe(1);
  expect(record.plan!.tasks[1]!.dependsOn).toEqual(["add"]);
  expect(record.dag!.nodes[1]!.base).toBe(record.dag!.nodes[0]!.integratedHead);
}, 30000);
it("stops new starts on unknown quota and resumes without repeating the approved plan", async () => {
  const { owned, cwd } = await fixture(),
    fake = dagAgents(undefined, false);
  const paused = await runOfficialDag(
    dagWorkflowOptions(cwd, owned, {
      agents: fake.agents,
      canStart: async () => null,
    }),
    signal(),
  );
  expect(paused.status).toBe("quota-paused");
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan"]);
  expect(dagResumeBlockReason(paused)).toBeNull();
  const resumed = await runOfficialDag(
    dagWorkflowOptions(cwd, owned, {
      agents: fake.agents,
      resume: paused,
      canStart: async () => true,
    }),
    signal(),
  );
  expect(resumed.status).toBe("completed");
  expect(fake.requests.filter((r) => r.phase === "plan")).toHaveLength(1);
}, 30000);
it("resumes a durable import checkpoint without importing a result twice", async () => {
  const { owned, cwd } = await fixture(),
    fake = dagAgents(undefined, false);
  let saved: WorkflowRecord | undefined;
  await expect(
    runOfficialDag(
      dagWorkflowOptions(cwd, owned, {
        agents: fake.agents,
        save: async (record) => {
          if (
            record.dag!.nodes.filter((n) => n.state === "integrated").length ===
              1 &&
            !record.pendingEffect
          ) {
            saved = structuredClone(record);
            throw new Error("process loss");
          }
        },
      }),
      signal(),
    ),
  ).rejects.toThrow();
  expect(saved).toBeDefined();
  expect(dagResumeBlockReason(saved!)).toBeNull();
  const before = fake.requests.length;
  const resumed = await runOfficialDag(
    dagWorkflowOptions(cwd, owned, { agents: fake.agents, resume: saved }),
    signal(),
  );
  expect(resumed.status).toBe("completed");
  expect(resumed.commits).toHaveLength(3);
  expect(
    fake.requests
      .slice(before)
      .filter((r) => r.phase === "implement")
      .map((r) => JSON.parse(r.prompt).task.id),
  ).toEqual(["combine"]);
}, 30000);
it.each(["cancelled", "failed", "quota-paused"] as const)(
  "%s dispatched work remains uncertain and dependants never start",
  async (status) => {
    const { owned, cwd } = await fixture(),
      fake = dagAgents(undefined, false),
      controller = new AbortController();
    const agents = {
      ...fake.agents,
      claude: {
        ...fake.agents.claude,
        run: async (
          request: Parameters<typeof fake.agents.claude.run>[0],
          s: AbortSignal,
        ) => {
          if (request.phase === "implement") {
            if (status === "cancelled") controller.abort();
            return {
              status,
              dispatched: true,
              elapsedMs: 0,
              observedModels: [],
              usage: null,
            };
          }
          return fake.agents.claude.run(request, s);
        },
      },
    };
    const record = await runOfficialDag(
      dagWorkflowOptions(cwd, owned, { agents }),
      controller.signal,
    );
    expect(["cancelled", "failed", "quota-paused"]).toContain(record.status);
    expect(dagResumeBlockReason(record)).toBe("uncertain-effect");
    expect(
      fake.requests.some(
        (r) =>
          r.phase === "implement" && JSON.parse(r.prompt).task.id === "combine",
      ),
    ).toBe(false);
  },
  30000,
);
it("preserves conflicting node results and clean integration HEAD on a definite cherry-pick conflict", async () => {
  const { owned, cwd } = await fixture(),
    manager = new OfficialWorktrees(cwd, owned, (s) => s),
    root = gitWorkspace(cwd, (s) => s),
    base = (await root.inspect(signal())).head;
  const paths = await Promise.all([
    manager.create(base, signal()),
    manager.create(base, signal()),
  ]);
  const heads: string[] = [];
  for (let i = 0; i < 2; i++) {
    await writeFile(
      join(paths[i]!, "add.mjs"),
      `export const add=()=>${i + 10};\n`,
    );
    heads.push(
      await (
        await manager.open(paths[i]!, signal())
      ).commit(["add.mjs"], signal()),
    );
  }
  const imported = await manager.integrate(
    paths[0]!,
    base,
    heads[0]!,
    base,
    ["add.mjs"],
    signal(),
  );
  await expect(
    manager.integrate(
      paths[1]!,
      base,
      heads[1]!,
      imported,
      ["add.mjs"],
      signal(),
    ),
  ).rejects.toThrow("integration-conflict");
  expect(await root.inspect(signal())).toEqual({ clean: true, head: imported });
  expect(await readFile(join(paths[1]!, "add.mjs"), "utf8")).toContain("11");
  await expect(manager.open(cwd, signal())).rejects.toThrow(
    "unowned-node-workspace",
  );
}, 30000);
