import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixtureModels, fixtureWorkflowOptions } from "./fixtures.js";
import { sdkUsage, codexUsage } from "./usage.js";
import { OfficialWorktrees } from "./worktrees.js";
import { scopedPath } from "./workspace.js";
import type { DagOptions } from "./dag.js";
import type {
  OfficialPlan,
  OfficialAgent,
  AgentRequest,
  AgentResult,
  TestSpec,
} from "./contracts.js";
const exec = promisify(execFile);
export const dagPlan = (): OfficialPlan => ({
  summary:
    "Fix independent arithmetic modules, then their dependent composition.",
  tasks: [
    {
      id: "add",
      title: "Addition",
      instructions: "Correct addition, preserve tests.",
      files: ["add.mjs"],
      dependsOn: [],
      acceptance: ["add"],
      assignee: {
        provider: "claude",
        model: "fixture-haiku",
        effort: null,
        reason: "Small independent change.",
      },
    },
    {
      id: "multiply",
      title: "Multiplication",
      instructions: "Correct multiplication, preserve tests.",
      files: ["multiply.mjs"],
      dependsOn: [],
      acceptance: ["multiply"],
      assignee: {
        provider: "codex",
        model: "fixture-codex",
        effort: null,
        reason: "Independent comparison candidate.",
      },
    },
    {
      id: "combine",
      title: "Composition",
      instructions: "Add the corrected addition and multiplication results.",
      files: ["combine.mjs"],
      dependsOn: ["add", "multiply"],
      acceptance: ["combine"],
      assignee: {
        provider: "claude",
        model: "fixture-haiku",
        effort: null,
        reason: "Requires both confirmed predecessor commits.",
      },
    },
  ],
});
const corrected: Record<string, string> = {
  "add.mjs": "export const add=(a,b)=>a+b;\n",
  "multiply.mjs": "export const multiply=(a,b)=>a*b;\n",
  "combine.mjs":
    "import {add} from './add.mjs';\nimport {multiply} from './multiply.mjs';\nexport const combine=(a,b)=>add(a,b)+multiply(a,b);\n",
};
export function dagTests(): TestSpec[] {
  return ["add", "multiply", "combine"].map((id) => ({
    id,
    program: process.versions.electron ? "node" : process.execPath,
    args: ["--test", `${id}.test.mjs`],
    command: `node --test ${id}.test.mjs`,
    timeoutMs: 10000,
  }));
}
export async function createDagWorkspace(
  parent = tmpdir(),
  ownedDirectory?: string,
) {
  const owned = ownedDirectory ?? (await mkdtemp(join(parent, "dag-"))),
    cwd = join(owned, "workspace-dag");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd);
  for (const [file, content] of Object.entries({
    ...corrected,
    "add.mjs": "export const add=(a,b)=>a-b;\n",
    "multiply.mjs": "export const multiply=(a,b)=>a+b;\n",
    "combine.mjs": "export const combine=()=>0;\n",
  }))
    await writeFile(join(cwd, file), content);
  for (const [id, value] of [
    ["add", 5],
    ["multiply", 6],
    ["combine", 11],
  ] as const)
    await writeFile(
      join(cwd, `${id}.test.mjs`),
      `import {test} from 'node:test';import assert from 'node:assert/strict';import {${id}} from './${id}.mjs';test('${id}',()=>assert.equal(${id}(2,3),${value}));\n`,
    );
  const git = (args: string[]) =>
    exec(
      "git",
      [
        "-c",
        `safe.directory=${cwd}`,
        "-c",
        "core.hooksPath=/xharness-disabled-hooks",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd, windowsHide: true },
    );
  await git(["init", "-q"]);
  await git(["add", "--", "."]);
  await git([
    "-c",
    "user.name=XHarness",
    "-c",
    "user.email=xharness@local",
    "commit",
    "-qm",
    "fixture: bounded DAG defects",
  ]);
  return { owned, cwd };
}
export function dagAgents(plan = dagPlan(), firstDefect = true) {
  const requests: AgentRequest[] = [];
  let active = 0,
    maxActive = 0;
  const create = (provider: "claude" | "codex"): OfficialAgent => ({
    provider,
    discover: async () => fixtureModels.filter((m) => m.provider === provider),
    async run(request, signal): Promise<AgentResult> {
      signal.throwIfAborted();
      requests.push(request);
      let output: unknown;
      const input = JSON.parse(request.prompt);
      if (request.phase === "plan") output = plan;
      else if (request.phase === "implement" || request.phase === "fix") {
        active++;
        maxActive = Math.max(active, maxActive);
        try {
          await new Promise<void>((done, fail) => {
            const cancel = () => {
              clearTimeout(timer);
              fail(new Error("fixture cancelled"));
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", cancel);
              done();
            }, 150);
            signal.addEventListener("abort", cancel, { once: true });
            if (signal.aborted) cancel();
          });
          for (const file of request.files) {
            const content =
              file === "add.mjs" && request.phase === "implement" && firstDefect
                ? "export const add=(a,b)=>a-b; // mock first defect\n"
                : corrected[file];
            if (!content) throw new Error("Unapproved fixture file");
            await writeFile(
              await scopedPath(request.cwd, file),
              content + `// ${input.task.id}\n`,
            );
          }
          output = {
            summary:
              "Mock claims success; process evidence remains authoritative.",
          };
        } finally {
          active--;
        }
      } else {
        const files = input.plan.tasks.flatMap(
            (t: { files: string[] }) => t.files,
          ) as string[],
          findings = [];
        for (const file of [...new Set(files)]) {
          const text = await readFile(
            await scopedPath(request.cwd, file),
            "utf8",
          );
          if (file === "add.mjs" && text.includes("a-b"))
            findings.push({
              severity: "must",
              file,
              line: 1,
              message: "Subtraction remains",
              evidence:
                "Full diff and independent acceptance show subtraction.",
            });
        }
        output = { base: input.base, head: input.head, findings };
      }
      return {
        status: "completed",
        dispatched: true,
        output,
        elapsedMs: 150,
        observedModels: [request.model.model],
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
    get maxActive() {
      return maxActive;
    },
  };
}
export function dagWorkflowOptions(
  cwd: string,
  owned: string,
  overrides: Partial<DagOptions> = {},
): DagOptions {
  return {
    ...fixtureWorkflowOptions(cwd),
    goal: "Correct the fixed arithmetic DAG without changing its tests.",
    files: Object.keys(corrected),
    tests: dagTests(),
    agents: dagAgents().agents,
    worktrees: new OfficialWorktrees(cwd, owned, (s) => s),
    ...overrides,
  };
}
