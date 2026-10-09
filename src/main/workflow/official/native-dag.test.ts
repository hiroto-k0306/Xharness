import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixturePlan, fixtureWorkflowOptions } from "./fixtures.js";
import { createIndependentValidator } from "./independent-validation.js";
import { createProjectDagWorkspace } from "./project-dag-workspace.js";
import {
  runNativePlannedWork,
  independentlyPassed,
  type NativeDagOptions,
} from "./native-dag.js";
import {
  WorkflowFailure,
  type OfficialPlan,
  type AgentRequest,
} from "./contracts.js";
import type { WorkflowRecord } from "./runtime.js";
const exec = promisify(execFile);
const isIntegrationReview = (request: AgentRequest) =>
  request.phase === "review" &&
  Array.isArray(JSON.parse(request.prompt).validation);
async function fixture(
  run: (
    options: NativeDagOptions,
    plan: OfficialPlan,
    requests: AgentRequest[],
    saved: WorkflowRecord[],
  ) => Promise<void>,
  git = true,
) {
  const root = await mkdtemp(join(tmpdir(), "xh-native-dag-")),
    cwd = join(root, "source");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd);
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  await writeFile(join(cwd, "b.mjs"), "export const b=0;\n");
  if (git) {
    await exec("git", ["init", "-q"], { cwd });
    await exec("git", ["add", "."], { cwd });
    await exec(
      "git",
      [
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@local",
        "commit",
        "-qm",
        "synthetic",
      ],
      { cwd },
    );
  }
  const first = fixturePlan().tasks[0]!;
  const plan: OfficialPlan = {
    summary: "Two independent changes",
    parallelization: {
      mode: "parallel",
      reason:
        "Separate paths and independent Node validation; at most two tasks",
      maxParallel: 2,
    },
    validation: { testFiles: ["add.test.mjs"] },
    tasks: [
      { ...first, id: "a", files: ["add.mjs", "add.test.mjs"] },
      { ...structuredClone(first), id: "b", files: ["b.mjs"] },
    ],
  };
  const requests: AgentRequest[] = [],
    saved: WorkflowRecord[] = [];
  const options: NativeDagOptions = {
    ...fixtureWorkflowOptions(cwd),
    prepareDag: (approvalDigest, signal) =>
      createProjectDagWorkspace({
        cwd,
        ownedRoot: join(root, "owned"),
        approvalDigest,
        signal,
      }),
    approveTool: async () => true,
    // Mock official API backed by a synthetic process: verifies shared sanitized evidence,
    // not production App Server or OS sandbox availability.
    validateIntegration: createIndependentValidator({
      nodeExecutable: process.execPath,
      verifiedSandbox: {
        cliVersion: "fixture-only-not-runtime-proof",
        commandExec: true,
        restrictedRead: true,
        networkDenied: true,
      },
      start: (cwd) => ({
        request: async (method, params, signal) => {
          if (method === "initialize") return {};
          if (method !== "command/exec") throw Error("unexpected fixture RPC");
          const { command } = params as { command: string[] };
          try {
            const result = await exec(command[0]!, command.slice(1), {
              cwd,
              signal,
              timeout: 60000,
              maxBuffer: 65536,
            });
            return {
              exitCode: 0,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          } catch (error) {
            const result = error as {
              code?: number;
              stdout?: string;
              stderr?: string;
            };
            return {
              exitCode: typeof result.code === "number" ? result.code : 1,
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
            };
          }
        },
        notify: () => {},
        subscribe: () => () => {},
        approve: () => {},
        close: () => {},
      }),
    }),
    save: async (record) => {
      saved.push(structuredClone(record));
    },
  };
  for (const provider of ["claude", "codex"] as const) {
    const agent = options.agents[provider];
    agent.run = async (request, signal) => {
      signal.throwIfAborted();
      requests.push(request);
      let output: unknown;
      if (request.phase === "plan") output = structuredClone(plan);
      else if (request.phase === "implement" || request.phase === "fix") {
        if (request.writeScope?.includes("b.mjs"))
          await writeFile(join(request.cwd, "b.mjs"), "export const b=1;\n");
        else {
          await writeFile(
            join(request.cwd, "add.mjs"),
            "export const add=(a,b)=>a+b;\n",
          );
          await writeFile(
            join(request.cwd, "add.test.mjs"),
            "import {test} from 'node:test';import {strict as assert} from 'node:assert';import {add} from './add.mjs';test('add',()=>assert.equal(add(2,3),5));\n",
          );
        }
        output = { summary: "Synthetic implementation", tests: [] };
      } else {
        const input = JSON.parse(request.prompt);
        output = { base: input.base, head: input.head, findings: [] };
      }
      return {
        status: "completed",
        dispatched: true,
        observedModels: [request.model.model],
        usage: null,
        elapsedMs: 1,
        output,
      };
    };
  }
  try {
    await run(options, plan, requests, saved);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}
it("plans once, executes isolated tasks, independent Node tests and overall cross-company review without changing user branch", async () =>
  fixture(async (o, _p, requests, saved) => {
    const initial = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: o.cwd })
    ).stdout.trim();
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.error, JSON.stringify(result.checks)).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(requests.filter((r) => r.phase === "plan")).toHaveLength(1);
    const integrationReviews = requests.filter(isIntegrationReview);
    expect(integrationReviews).toHaveLength(1);
    expect(
      integrationReviews.every(
        (r) => r.phase === "review" && r.writeScope === undefined,
      ),
    ).toBe(true);
    expect(
      requests
        .filter((r) => r.phase === "implement")
        .every((r) => !!r.writeScope?.length),
    ).toBe(true);
    expect(result.nativeWork?.validation).toBe("independent-process");
    const evidence = JSON.parse(result.checks[0]!.tests[0]!.output);
    expect(evidence.mechanism).toBe("official-command-exec");
    expect(evidence.counts.pass).toBeGreaterThan(0);
    expect(result.checks[0]!.tests[0]!.output).not.toContain("TAP version");
    expect(result.checks[0]?.tests[0]?.source).toBe("process");
    expect(result.dag?.nodes).toHaveLength(2);
    expect(result.dag?.nodes.every((n) => n.state === "completed")).toBe(true);
    expect(
      requests
        .filter((r) => r.phase === "implement")
        .every((r) => r.cwd !== o.cwd && r.writeScope?.length),
    ).toBe(true);
    expect(await readFile(join(o.cwd, "add.mjs"), "utf8")).toContain("a-b");
    expect(
      (await exec("git", ["rev-parse", "HEAD"], { cwd: o.cwd })).stdout.trim(),
    ).toBe(initial);
    expect(saved.some((r) => r.pendingEffect?.kind === "worktree")).toBe(true);
    expect(saved.some((r) => r.pendingEffect?.kind === "test")).toBe(true);
    expect(
      saved.some((r) =>
        r.calls.some((c) => c.nodeId && c.status === "running"),
      ),
    ).toBe(true);
  }));
it("serial decision preserves non-Git ordinary path and does not re-query planner", async () =>
  fixture(async (o, p, requests) => {
    p.parallelization = {
      mode: "serial",
      reason: "Non-Git project; coordination unnecessary",
      maxParallel: 1,
    };
    p.tasks = [p.tasks[0]!];
    delete p.validation;
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(requests.filter((r) => r.phase === "plan")).toHaveLength(1);
    expect(result.nativeWork?.validation).toBe("agent-reported");
    expect(result.nativeDagWorkspace).toBeUndefined();
  }, false));
it.each([
  "cycle",
  "overlap",
  "missing-validation",
  "missing-decision",
  "dirty",
  "deny",
])("stops %s before isolated writes", async (kind) =>
  fixture(async (o, p, requests) => {
    if (kind === "cycle") {
      p.tasks[0]!.dependsOn = ["b"];
      p.tasks[1]!.dependsOn = ["a"];
    }
    if (kind === "overlap") p.tasks[1]!.files = ["add.mjs"];
    if (kind === "missing-validation") delete p.validation;
    if (kind === "missing-decision") delete p.parallelization;
    if (kind === "dirty")
      await writeFile(join(o.cwd, "b.mjs"), "preexisting change");
    if (kind === "deny") o.approve = async () => false;
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.status).not.toBe("completed");
    expect(requests.some((r) => r.phase === "implement")).toBe(false);
    expect(await readFile(join(o.cwd, "add.mjs"), "utf8")).toContain("a-b");
  }),
);
it("dependencies receive committed predecessor changes and integration is deterministic", async () =>
  fixture(async (o, p) => {
    p.tasks[1]!.dependsOn = ["a"];
    const original = o.agents.claude.run;
    o.agents.claude.run = async (r, s) => {
      if (r.phase === "implement" && r.writeScope?.includes("b.mjs"))
        expect(await readFile(join(r.cwd, "add.mjs"), "utf8")).toContain("a+b");
      return original(r, s);
    };
    expect(
      (await runNativePlannedWork(o, new AbortController().signal)).status,
    ).toBe("completed");
  }));
it.each(["denied", "failed", "skipped", "mutation"])(
  "cannot complete with independent validation %s",
  async (kind) =>
    fixture(async (o, _p, requests) => {
      if (kind === "denied") o.approveTool = async () => false;
      else {
        const original = o.agents.claude.run;
        o.agents.claude.run = async (r, s) => {
          const result = await original(r, s);
          if (r.phase === "implement" && r.writeScope?.includes("add.test.mjs"))
            await writeFile(
              join(r.cwd, "add.test.mjs"),
              kind === "skipped"
                ? "import {test} from 'node:test';test.skip('skipped',()=>{});\n"
                : kind === "mutation"
                  ? "import {test} from 'node:test';import {writeFileSync} from 'node:fs';test('mutation',()=>writeFileSync('b.mjs','mutated'));\n"
                  : "import {test} from 'node:test';test('failure',()=>{throw Error('synthetic');});\n",
            );
          return result;
        };
      }
      const result = await runNativePlannedWork(
        o,
        new AbortController().signal,
      );
      expect(result.status).toBe("attention");
      expect(result.error).toContain(
        kind === "denied"
          ? "denied"
          : kind === "mutation"
            ? "mutated"
            : "validation-failed",
      );
      expect(requests.filter(isIntegrationReview)).toHaveLength(0);
      expect(result.nativeDagWorkspace).toBeDefined();
    }),
);
it("rejects agent writes outside approved scope even when agent reports success", async () =>
  fixture(async (o) => {
    const original = o.agents.claude.run;
    o.agents.claude.run = async (r, s) => {
      const result = await original(r, s);
      if (r.phase === "implement")
        await writeFile(join(r.cwd, "unapproved.txt"), "outside");
      return result;
    };
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.status).toBe("attention");
    expect(result.error).toBe("native-dag-write-scope-violation");
    expect(result.commits).toHaveLength(0);
  }));
it("sanitized independent JSON evidence requires validated counts and digest; raw TAP is never accepted", () => {
  const evidence = {
    mechanism: "official-command-exec",
    status: "passed",
    counts: { tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    outputDigest: "a".repeat(64),
  };
  expect(independentlyPassed(JSON.stringify(evidence))).toBe(true);
  for (const invalid of [
    { ...evidence, status: "failed-or-unconfirmed" },
    { ...evidence, counts: null },
    { ...evidence, counts: { ...evidence.counts, pass: 0 } },
    { ...evidence, counts: { ...evidence.counts, todo: 1 } },
    { ...evidence, counts: { ...evidence.counts, tests: 2 } },
    { ...evidence, mechanism: "agent-reported" },
    { ...evidence, outputDigest: "invalid" },
    { ...evidence, raw: "TAP output must not be persisted" },
  ])
    expect(independentlyPassed(JSON.stringify(invalid))).toBe(false);
  expect(
    independentlyPassed("# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n"),
  ).toBe(false);
});
it("stops missing independent validator before approval and implementation", async () =>
  fixture(async (o, _p, requests) => {
    delete o.validateIntegration;
    let approval = 0;
    o.approve = async () => {
      approval++;
      return true;
    };
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.error).toBe("independent-validation-unavailable");
    expect(approval).toBe(0);
    expect(requests.some((r) => r.phase === "implement")).toBe(false);
  }));
it("actually overlaps two independent task calls without exceeding two", async () =>
  fixture(async (o, p) => {
    p.tasks.push({
      ...structuredClone(p.tasks[1]!),
      id: "c",
      files: ["c.mjs"],
    });
    let active = 0,
      max = 0,
      entered = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => {
      release = r;
    });
    const original = o.agents.claude.run;
    o.agents.claude.run = async (r, s) => {
      if (r.phase !== "implement") return original(r, s);
      active++;
      max = Math.max(max, active);
      if (++entered === 2) release();
      await both;
      try {
        if (r.writeScope?.includes("c.mjs")) {
          await writeFile(join(r.cwd, "c.mjs"), "export const c=1;\n");
          return {
            status: "completed",
            dispatched: true,
            observedModels: [r.model.model],
            usage: null,
            elapsedMs: 1,
            output: { summary: "third synthetic task", tests: [] },
          };
        }
        return await original(r, s);
      } finally {
        active--;
      }
    };
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(max).toBe(2);
    expect(entered).toBe(3);
  }));
it("a failed task cancels and awaits its running sibling, preserving uncertain evidence without resend", async () =>
  fixture(async (o, _p, requests, saved) => {
    let starts = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => {
      release = r;
    });
    let siblingCancelled = false;
    const original = o.agents.claude.run;
    o.agents.claude.run = async (r, s) => {
      if (r.phase !== "implement") return original(r, s);
      if (++starts === 2) release();
      await both;
      if (r.writeScope?.includes("b.mjs")) {
        await new Promise<void>((resolve) => {
          if (s.aborted) {
            siblingCancelled = true;
            resolve();
          } else
            s.addEventListener(
              "abort",
              () => {
                siblingCancelled = true;
                resolve();
              },
              { once: true },
            );
        });
        s.throwIfAborted();
      }
      return {
        status: "failed",
        dispatched: true,
        observedModels: [],
        usage: null,
        elapsedMs: 1,
        error: "synthetic-node-failure",
      };
    };
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.status).toBe("attention");
    expect(result.error).toBe("synthetic-node-failure");
    expect(siblingCancelled).toBe(true);
    expect(requests.filter((r) => r.phase === "plan")).toHaveLength(1);
    expect(starts).toBe(2);
    expect(saved.at(-1)?.dag?.nodes.every((n) => n.state === "stopped")).toBe(
      true,
    );
    expect(result.commits).toHaveLength(0);
  }));
it("overall integration review findings prevent completion after passing independent process evidence", async () =>
  fixture(async (o) => {
    const original = o.agents.codex.run;
    o.agents.codex.run = async (r, s) => {
      const result = await original(r, s);
      if (isIntegrationReview(r)) {
        const input = JSON.parse(r.prompt);
        result.output = {
          base: input.base,
          head: input.head,
          findings: [
            {
              severity: "must",
              file: "add.mjs",
              line: 1,
              message: "synthetic integration issue",
              evidence: "synthetic fixed diff evidence",
            },
          ],
        };
      }
      return result;
    };
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.status).toBe("attention");
    expect(result.error).toBe("integration-review-blocking");
    expect(result.checks[0]?.tests[0]?.passed).toBe(true);
  }));

it("runtime identity lost during approval stops before worktree creation or implementation", async () =>
  fixture(async (o, _p, requests, saved) => {
    let checks = 0;
    let prepared = 0;
    const prepare = o.prepareDag;
    o.checkValidationRuntime = async () => {
      if (++checks === 2)
        throw new WorkflowFailure("validation-runtime-identity-changed");
    };
    o.prepareDag = async (...args) => {
      prepared++;
      return prepare(...args);
    };
    const result = await runNativePlannedWork(o, new AbortController().signal);
    expect(result.status).toBe("attention");
    expect(result.error).toBe("validation-runtime-identity-changed");
    expect(checks).toBe(2);
    expect(prepared).toBe(0);
    expect(requests.filter((r) => r.phase === "implement")).toHaveLength(0);
    expect(saved.some((r) => r.pendingEffect?.kind === "worktree")).toBe(false);
  }));
