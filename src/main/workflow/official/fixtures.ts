import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sdkUsage, codexUsage } from "./usage.js";
import { digest, type WorkflowOptions } from "./runtime.js";
import type {
  OfficialPlan,
  OfficialAgent,
  AgentRequest,
  AgentResult,
  ModelCandidate,
  TestSpec,
} from "./contracts.js";
import {
  gitWorkspace,
  workflowGitEnvironment,
  workflowGitPolicyArgs,
} from "./workspace.js";
import {
  TYPED_ADD_SOURCE,
  TYPED_ADD_TASK,
  TYPED_ADD_TEST,
} from "./fault-injection.js";
const exec = promisify(execFile);
export const fixtureModels: ModelCandidate[] = [
  {
    provider: "claude",
    model: "fixture-opus",
    efforts: [null, "high"],
    available: true,
    quotaAllowed: true,
    capabilitySource: "fixture",
  },
  {
    provider: "claude",
    model: "fixture-haiku",
    efforts: [null],
    available: true,
    quotaAllowed: true,
    capabilitySource: "fixture",
  },
  {
    provider: "codex",
    model: "fixture-codex",
    efforts: [null, "low"],
    available: true,
    quotaAllowed: true,
    capabilitySource: "fixture",
  },
];
export const fixturePlan = (
  p: "claude" | "codex" = "claude",
): OfficialPlan => ({
  summary: "Fix one arithmetic function and verify it independently.",
  tasks: [
    {
      id: "arithmetic",
      title: "Fix add",
      instructions: "Make add(2,3) return 5. Preserve the acceptance test.",
      files: ["add.mjs"],
      dependsOn: [],
      acceptance: ["arithmetic"],
      assignee: {
        provider: p,
        model: p === "claude" ? "fixture-haiku" : "fixture-codex",
        effort: null,
        reason:
          "Small bounded implementation; cross-provider review is independent.",
      },
      reviewer:
        p === "claude"
          ? {
              provider: "codex",
              model: "fixture-codex",
              effort: "low",
              reason: "Different company from the implementation.",
            }
          : {
              provider: "claude",
              model: "fixture-opus",
              effort: "high",
              reason: "Different company from the implementation.",
            },
    },
  ],
});
export async function createSyntheticWorkspace(
  prefix = "xh-official-workflow-",
  parent = tmpdir(),
  /** The verification-only typed-add task; omitted keeps the default task. */
  task?: typeof TYPED_ADD_TASK,
) {
  const cwd = await mkdtemp(join(parent, prefix));
  await writeFile(
    join(cwd, "add.mjs"),
    task ? TYPED_ADD_SOURCE : "export const add = (a, b) => a - b;\n",
  );
  await writeFile(
    join(cwd, "acceptance.test.mjs"),
    task
      ? TYPED_ADD_TEST
      : 'import {test} from "node:test";\nimport assert from "node:assert/strict";\nimport {add} from "./add.mjs";\ntest("add is addition",()=>{assert.equal(add(2,3),5);assert.equal(add(-1,1),0);});\n',
  );
  const run = async (step: "init" | "add" | "commit", args: string[]) => {
    try {
      await exec(
        "git",
        [...workflowGitPolicyArgs(), "-c", `safe.directory=${cwd}`, ...args],
        { cwd, windowsHide: true, env: workflowGitEnvironment() },
      );
    } catch (error) {
      // Native messages/output can contain configuration or secrets. Expose
      // only the fixed preparation step and a bounded process failure code.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const exit =
        typeof code === "number" && Number.isSafeInteger(code) ? code : "不明";
      const nativeCode =
        typeof code === "string" &&
        /^(ENOENT|EACCES|EPERM|ETIMEDOUT|ENOSPC|EBUSY|EIO)$/.test(code)
          ? code
          : "unknown";
      throw new Error(
        `合成課題のGit準備に失敗しました（${step}: code ${nativeCode}, exit ${exit}）。再送していません。`,
      );
    }
  };
  await run("init", ["init", "-q"]);
  await run("add", ["add", "--", "add.mjs", "acceptance.test.mjs"]);
  await run("commit", [
    "-c",
    "user.name=XHarness",
    "-c",
    "user.email=xharness@local",
    "commit",
    "-qm",
    task ? `fixture: ${task}` : "fixture: seeded arithmetic defect",
  ]);
  return cwd;
}
export const fixtureTest = (): TestSpec => ({
  id: "arithmetic",
  program: process.versions.electron ? "node" : process.execPath,
  args: ["--test", "acceptance.test.mjs"],
  command: "node --test acceptance.test.mjs",
  timeoutMs: 10000,
});
export function fixtureAgents(
  implementation: "claude" | "codex" = "claude",
  failFirst = true,
) {
  let implementations = 0;
  const requests: AgentRequest[] = [];
  const create = (provider: "claude" | "codex"): OfficialAgent => ({
    provider,
    discover: async () => fixtureModels.filter((m) => m.provider === provider),
    async run(request, signal): Promise<AgentResult> {
      signal.throwIfAborted();
      requests.push(request);
      let output: unknown;
      if (request.phase === "plan") {
        const plan = fixturePlan(implementation);
        const registered = JSON.parse(request.prompt).acceptanceTests;
        if (Array.isArray(registered))
          plan.tasks[0]!.acceptance = registered.map(
            (t: { id: string }) => t.id,
          );
        output = plan;
      } else if (request.phase === "implement" || request.phase === "fix") {
        const content =
          implementations++ === 0 && failFirst && request.phase !== "fix"
            ? "export const add = (a,b) => a-b; // intentionally incorrect first mock attempt\n"
            : "export const add = (a,b) => a+b;\n";
        const evidence = {
          actionId: `mock-write-${implementations}`,
          name: "Write",
          inputDigest: digest(content),
          source: "plan" as const,
        };
        await request.tool({ ...evidence, status: "allowed" });
        await writeFile(join(request.cwd, "add.mjs"), content);
        await request.tool({
          ...evidence,
          status: "completed",
          outputDigest: digest("written"),
        });
        output = {
          summary: "Model claims success; X must run the actual tests.",
          ...(request.nativeWork ? { tests: [] } : {}),
        };
      } else {
        const input = JSON.parse(request.prompt),
          text = await readFile(join(request.cwd, "add.mjs"), "utf8");
        output = {
          base: input.base,
          head: input.head,
          findings: text.includes("a-b")
            ? [
                {
                  severity: "must",
                  file: "add.mjs",
                  line: 1,
                  message: "Subtraction remains",
                  evidence:
                    "The fixed diff still contains a-b and the independently executed arithmetic test fails.",
                },
              ]
            : [],
        };
      }
      return {
        status: "completed",
        dispatched: true,
        output,
        observedModels: [request.model.model],
        elapsedMs: 1,
        usage:
          provider === "codex"
            ? codexUsage({
                total: {
                  inputTokens: 14,
                  outputTokens: 2,
                  cachedInputTokens: 3,
                  totalTokens: 16,
                },
              })
            : sdkUsage({
                modelUsage: {
                  [request.model.model]: {
                    inputTokens: 10,
                    outputTokens: 2,
                    cacheReadInputTokens: 3,
                    cacheCreationInputTokens: 1,
                  },
                },
              }),
      };
    },
  });
  return {
    agents: { claude: create("claude"), codex: create("codex") },
    requests,
  };
}
export function fixtureWorkflowOptions(
  cwd: string,
  overrides: Partial<WorkflowOptions> = {},
): WorkflowOptions {
  return {
    goal: "Correct addition without modifying the test.",
    cwd,
    files: ["add.mjs"],
    tests: [fixtureTest()],
    integrationTests: [],
    models: fixtureModels,
    planner: { model: "fixture-opus", effort: "high" },
    reviewers: {
      claude: { model: "fixture-opus", effort: "high" },
      codex: { model: "fixture-codex", effort: "low" },
    },
    agents: fixtureAgents().agents,
    workspace: gitWorkspace(cwd, (s) => s),
    simulated: true,
    save: async () => {},
    approve: async () => true,
    approveTool: async () => false,
    ...overrides,
  };
}
