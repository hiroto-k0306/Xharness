import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  FIX_CYCLE_BUDGET,
  FIX_CYCLE_SPEC,
  INJECTED_SOURCE,
  TYPED_ADD_GOAL,
  TYPED_ADD_TASK,
  typedAddTest,
  verificationMode,
} from "./fault-injection.js";
import {
  createSyntheticWorkspace,
  fixtureModels,
  fixturePlan,
  fixtureWorkflowOptions,
} from "./fixtures.js";
import {
  resumeBlockReason,
  runOfficialSingleTask,
  type WorkflowOptions,
  type WorkflowRecord,
} from "./runtime.js";
import { gitWorkspace, runAcceptance } from "./workspace.js";
import { officialWorkflowReport } from "./report.js";
import { OfficialWorkflowService } from "./service.js";
import type {
  AgentRequest,
  AgentResult,
  OfficialAgent,
  TestSpec,
} from "./contracts.js";

const exec = promisify(execFile);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0))
    await rm(d, { recursive: true, force: true, maxRetries: 5 });
});
const signal = () => new AbortController().signal;
const folder = async () => {
  const d = await mkdtemp(join(tmpdir(), "xh-fault-"));
  dirs.push(d);
  return d;
};
const CORRECT =
  'export const add = (a, b) => {\n  if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b))\n    throw new TypeError("finite numbers only");\n  return a + b;\n};\n';
const WRONG = "export const add = (a, b) => a + b;\n";

/** Agents that implement / fix / review the typed-add task deterministically. */
function agents(
  opts: {
    implement?: string;
    fix?: string;
    review?: (text: string) => { severity: "must" | "nit"; message: string }[];
  } = {},
) {
  const requests: AgentRequest[] = [];
  const result = (output: unknown, model: string): AgentResult => ({
    status: "completed",
    dispatched: true,
    output,
    observedModels: [model],
    usage: null,
    elapsedMs: 1,
  });
  const create = (provider: "claude" | "codex"): OfficialAgent => ({
    provider,
    discover: async () => fixtureModels.filter((m) => m.provider === provider),
    async run(request) {
      requests.push(request);
      if (request.phase === "plan") {
        const plan = fixturePlan("codex");
        return result(
          {
            ...plan,
            tasks: plan.tasks.map((t) => ({ ...t, acceptance: ["typed-add"] })),
          },
          request.model.model,
        );
      }
      if (request.phase === "implement" || request.phase === "fix") {
        await writeFile(
          join(request.cwd, "add.mjs"),
          request.phase === "fix"
            ? (opts.fix ?? CORRECT)
            : (opts.implement ?? CORRECT),
        );
        return result({ summary: "done" }, request.model.model);
      }
      const input = JSON.parse(request.prompt);
      const text = await readFile(join(request.cwd, "add.mjs"), "utf8");
      const findings = (
        opts.review ??
        ((t: string) =>
          t.includes("fault injection")
            ? [{ severity: "must" as const, message: "Subtraction" }]
            : [])
      )(text).map((f) => ({
        ...f,
        file: "add.mjs",
        line: 1,
        evidence: "Read from the supplied diff.",
      }));
      return result(
        { base: input.base, head: input.head, findings },
        request.model.model,
      );
    },
  });
  return {
    agents: { claude: create("claude"), codex: create("codex") },
    requests,
  };
}
async function setup(
  overrides: Partial<WorkflowOptions> = {},
  fake = agents(),
  task: typeof TYPED_ADD_TASK | undefined = TYPED_ADD_TASK,
) {
  const parent = await folder();
  const cwd = await createSyntheticWorkspace("workspace-", parent, task);
  const options = fixtureWorkflowOptions(cwd, {
    goal: TYPED_ADD_GOAL,
    tests: [typedAddTest()],
    agents: fake.agents,
    faultInjection: { spec: FIX_CYCLE_SPEC, allowedRoot: parent },
    callBudget: { ...FIX_CYCLE_BUDGET },
    ...overrides,
  });
  return { cwd, parent, options, fake };
}
const log = async (cwd: string) =>
  (
    await exec(
      "git",
      ["-c", `safe.directory=${cwd}`, "log", "--format=%an|%s"],
      {
        cwd,
      },
    )
  ).stdout.trim();

it("turns on only with the flag, the environment value and an isolated home", () => {
  const argv = ["--official-only", "--verify-fix-cycle"];
  const env = {
    XHARNESS_FAULT_INJECTION: FIX_CYCLE_SPEC,
    XHARNESS_HOME: join(tmpdir(), "xh-isolated"),
  };
  const home = join(tmpdir(), "default-home");
  expect(verificationMode(argv, env, home)).toBe(FIX_CYCLE_SPEC);
  expect(verificationMode(["--official-only"], env, home)).toBeUndefined();
  expect(verificationMode(["--verify-fix-cycle"], env, home)).toBeUndefined();
  expect(
    verificationMode(argv, { ...env, XHARNESS_FAULT_INJECTION: "1" }, home),
  ).toBeUndefined();
  expect(
    verificationMode(argv, { ...env, XHARNESS_HOME: undefined }, home),
  ).toBeUndefined();
  expect(
    verificationMode(argv, { ...env, XHARNESS_HOME: "relative" }, home),
  ).toBeUndefined();
  expect(
    verificationMode(argv, { ...env, XHARNESS_HOME: home }, home),
  ).toBeUndefined();
});

it("ships a task whose test fails the seed and the injected defect and passes the spec", async () => {
  const parent = await folder();
  const cwd = await createSyntheticWorkspace("w-", parent, TYPED_ADD_TASK);
  const test = typedAddTest();
  const run = () => runAcceptance(cwd, test, signal(), (s) => s);
  expect((await run()).passed).toBe(false);
  await writeFile(join(cwd, "add.mjs"), INJECTED_SOURCE);
  expect((await run()).passed).toBe(false);
  await writeFile(join(cwd, "add.mjs"), WRONG);
  expect((await run()).passed).toBe(false); // NaN/Infinity/strings must throw
  await writeFile(join(cwd, "add.mjs"), CORRECT);
  const passed = await run();
  expect(passed.passed).toBe(true);
  expect(passed.exitCode).toBe(0);
  const text = await readFile(join(cwd, "acceptance.test.mjs"), "utf8");
  for (const c of [
    "[NaN, 1]",
    "[1, NaN]",
    "[-Infinity, 1]",
    "[1, -Infinity]",
    "[undefined, 1]",
    "[1, undefined]",
    '["2", 3]',
    '[2, "3"]',
    "0.75",
  ])
    expect(text).toContain(c);
});

it("separates X1 quality, X2 injection and X3 fix with fresh tests and reviews against one base", async () => {
  const { cwd, options, fake } = await setup();
  const result = await runOfficialSingleTask(options, signal());
  expect(result.status).toBe("completed");
  const [x1, x2, x3] = result.commits;
  expect(result.commits).toHaveLength(3);
  expect(result.head).toBe(x3);
  expect(result.injection).toMatchObject({
    state: "injected",
    attempts: 1,
    stages: [
      { stage: "quality", head: x1, check: 0 },
      { stage: "injected", head: x2, check: 1, review: 0 },
      { stage: "fix", head: x3, check: 2, review: 1 },
    ],
  });
  // Each check and review belongs to its own head; X1 is never reviewed.
  expect(result.checks.map((c) => [c.head, c.tests[0]!.passed])).toEqual([
    [x1, true],
    [x2, false],
    [x3, true],
  ]);
  // An expected assertion failure, not infrastructure trouble.
  expect(result.checks[1]!.tests[0]!.exitCode).toBe(1);
  expect(result.reviews.map((r) => [r.base, r.head])).toEqual([
    [result.base, x2],
    [result.base, x3],
  ]);
  expect(fake.requests.map((r) => r.phase)).toEqual([
    "plan",
    "implement",
    "review",
    "fix",
    "review",
  ]);
  // The fix receives the X2 failure and the real review of X2.
  const fix = JSON.parse(fake.requests[3]!.prompt);
  expect(fix.checks.head).toBe(x2);
  expect(fix.review.head).toBe(x2);
  expect(fix.previousDiff).toContain("fault injection");
  expect(result.callBudget).toEqual({
    limits: FIX_CYCLE_BUDGET,
    reserved: { plan: 1, implement: 1, review: 2, fix: 1 },
  });
  expect((await log(cwd)).split("\n")).toEqual([
    "XHarness|workflow: approved single-task change",
    expect.stringMatching(
      /^XHarness fault-injection\|fault-injection: fix-cycle-v1 [0-9a-f-]{36}$/,
    ),
    "XHarness|workflow: approved single-task change",
    "XHarness|fixture: typed-add-v1",
  ]);
  const html = officialWorkflowReport(result);
  expect(html).toContain("X1 実装品質（注入前。レビュー対象外）");
  expect(html).toContain("X2 障害注入");
  expect(html).toContain("X3 修正");
  expect(html).toContain("通信上限（送信前に予約）");
});

it("does not pass a failed test when the review has no findings", async () => {
  const { options } = await setup({}, agents({ review: () => [] }));
  const result = await runOfficialSingleTask(options, signal());
  expect(result.reviews[0]!.findings).toEqual([]);
  expect(result.correctionRounds).toBe(1);
  expect(result.status).toBe("completed");
  expect(result.checks.at(-1)!.tests[0]!.passed).toBe(true);
});

it("does not inject when X1 fails its quality test and follows the natural fix path", async () => {
  const fake = agents({ implement: WRONG });
  const { cwd, options } = await setup({}, fake);
  const result = await runOfficialSingleTask(options, signal());
  expect(result.injection).toMatchObject({
    state: "skipped-quality-failed",
    attempts: 0,
    stages: [{ stage: "quality", head: result.commits[0] }],
  });
  expect(await log(cwd)).not.toContain("fault-injection");
  expect(result.reviews[0]!.head).toBe(result.commits[0]);
});

it.each([
  ["outside the allowed folder", "fault-injection-outside-boundary", true],
  ["a non-synthetic workspace", "fault-injection-not-synthetic-task", false],
] as const)("never injects into %s", async (_name, code, typed) => {
  const other = await folder();
  const { cwd, options, parent, fake } = await setup(
    {},
    agents(),
    typed ? TYPED_ADD_TASK : undefined,
  );
  if (typed)
    options.faultInjection = { spec: FIX_CYCLE_SPEC, allowedRoot: other };
  else options.faultInjection = { spec: FIX_CYCLE_SPEC, allowedRoot: parent };
  if (!typed) {
    // A default-task workspace whose test still passes the X1 quality check.
    await writeFile(join(cwd, "acceptance.test.mjs"), "");
    await exec(
      "git",
      [
        "-c",
        `safe.directory=${cwd}`,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@local",
        "commit",
        "-qam",
        "empty test",
      ],
      { cwd },
    );
    options.workspace = gitWorkspace(cwd, (s) => s);
  }
  const result = await runOfficialSingleTask(options, signal());
  expect(result.status).toBe("failed");
  expect(result.error).toBe(code);
  expect(result.injection).toMatchObject({ state: "failed", attempts: 0 });
  expect(await log(cwd)).not.toContain("fault-injection");
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan", "implement"]);
  expect(resumeBlockReason(result)).toBe("uncertain-injection");
});

it("stops before review when the injection is ineffective", async () => {
  const always: TestSpec = {
    ...typedAddTest(),
    program: process.execPath,
    args: ["-e", ""],
  };
  const { options, fake } = await setup({ tests: [always] });
  const result = await runOfficialSingleTask(options, signal());
  expect(result.error).toBe("fault-injection-ineffective");
  expect(result.injection!.state).toBe("ineffective");
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan", "implement"]);
});

it("stops on test infrastructure trouble instead of fixing", async () => {
  const broken: TestSpec = {
    ...typedAddTest(),
    program: join(tmpdir(), "xh-no-such-program.exe"),
  };
  const { options, fake } = await setup({ tests: [broken] });
  const result = await runOfficialSingleTask(options, signal());
  expect(result.error).toBe("verification-infrastructure");
  expect(fake.requests.map((r) => r.phase)).toEqual(["plan", "implement"]);
});

it("never re-injects after an interruption during injection, even with HEAD at X1", async () => {
  let checkpoint: WorkflowRecord | undefined;
  const { cwd, options } = await setup({
    save: async (r) => {
      if (r.pendingEffect?.kind === "inject") {
        checkpoint = structuredClone(r);
        throw new Error("fixture process interruption");
      }
    },
  });
  await expect(runOfficialSingleTask(options, signal())).rejects.toThrow();
  expect(checkpoint!.injection!.state).toBe("injecting");
  expect(checkpoint!.head).toBe(checkpoint!.commits[0]);
  expect(await log(cwd)).not.toContain("fault-injection");
  expect(resumeBlockReason(checkpoint!)).toBe("uncertain-injection");
  // Even with the pending marker cleared, an attempted injection never repeats.
  const cleared = structuredClone(checkpoint!);
  delete cleared.pendingEffect;
  expect(resumeBlockReason(cleared)).toBe("uncertain-injection");
  await expect(
    runOfficialSingleTask(
      { ...options, resume: cleared, save: async () => {} },
      signal(),
    ),
  ).rejects.toThrow("uncertain-injection");
});

it("resumes after the injection without injecting twice and keeps the call reservations", async () => {
  let checkpoint: WorkflowRecord | undefined;
  const { cwd, options } = await setup({
    save: async (r) => {
      if (
        r.next === "review" &&
        r.injection?.state === "injected" &&
        !r.reviews.length
      ) {
        checkpoint = structuredClone(r);
        throw new Error("fixture process interruption");
      }
    },
  });
  await expect(runOfficialSingleTask(options, signal())).rejects.toThrow();
  expect(resumeBlockReason(checkpoint!)).toBeNull();
  const fake = agents();
  const resumed = await runOfficialSingleTask(
    {
      ...options,
      agents: fake.agents,
      resume: checkpoint,
      save: async () => {},
    },
    signal(),
  );
  expect(resumed.status).toBe("completed");
  expect(resumed.injection!.attempts).toBe(1);
  expect((await log(cwd)).match(/fault-injection/g)).toHaveLength(2); // author + subject of one commit
  expect(fake.requests.map((r) => r.phase)).toEqual([
    "review",
    "fix",
    "review",
  ]);
  expect(resumed.callBudget!.reserved).toEqual({
    plan: 1,
    implement: 1,
    review: 2,
    fix: 1,
  });
  // Turning the injection or the budget off changes the run's scope.
  await expect(
    runOfficialSingleTask(
      { ...options, faultInjection: undefined, resume: checkpoint },
      signal(),
    ),
  ).rejects.toThrow("execution-scope-changed");
  await expect(
    runOfficialSingleTask(
      {
        ...options,
        callBudget: { ...FIX_CYCLE_BUDGET, fix: 5 },
        resume: checkpoint,
      },
      signal(),
    ),
  ).rejects.toThrow("execution-scope-changed");
});

it("refuses a call over the per-phase budget before sending it", async () => {
  // The fix never clears the defect, so a second fix would be needed.
  const fake = agents({ fix: INJECTED_SOURCE });
  const { options } = await setup({}, fake);
  const result = await runOfficialSingleTask(options, signal());
  expect(result.status).toBe("failed");
  expect(result.error).toBe("call-budget-exceeded");
  expect(fake.requests.map((r) => r.phase)).toEqual([
    "plan",
    "implement",
    "review",
    "fix",
    "review",
  ]);
  expect(result.calls.filter((c) => c.phase === "fix")).toHaveLength(1);
});

it("keeps normal runs free of injection and budgets", async () => {
  const parent = await folder();
  const cwd = await createSyntheticWorkspace("w-", parent);
  const result = await runOfficialSingleTask(
    fixtureWorkflowOptions(cwd),
    signal(),
  );
  expect(result.status).toBe("completed");
  expect(result.injection).toBeUndefined();
  expect(result.callBudget).toBeUndefined();
  expect(await log(cwd)).not.toContain("fault-injection");
});

it("creates the verification task only in the verification mode", async () => {
  const home = await folder();
  const off = new OfficialWorkflowService({ home, fake: true });
  const view = await off.command({ action: "list" });
  expect(view.verification).toBeUndefined();
  const refused = await off.command({
    action: "create",
    provider: "codex",
    task: "typed-add-v1",
  });
  expect(refused.error).toMatch(/検証モード/);
  expect(refused.records).toHaveLength(0);
  const on = new OfficialWorkflowService({
    home: await folder(),
    fake: true,
    verification: FIX_CYCLE_SPEC,
  });
  expect((await on.command({ action: "list" })).verification).toBe(
    FIX_CYCLE_SPEC,
  );
});
