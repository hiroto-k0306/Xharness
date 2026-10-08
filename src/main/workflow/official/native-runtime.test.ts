import { it, expect } from "vitest";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNativeTask } from "./native-runtime.js";
import { nativeSnapshot, nativeDiff } from "./native-snapshot.js";
import { fixtureWorkflowOptions, fixtureAgents } from "./fixtures.js";
import {
  resumeBlockReason,
  type WorkflowOptions,
  type WorkflowRecord,
} from "./runtime.js";
import { officialWorkflowReport } from "./report.js";

async function fixture(
  run: (cwd: string, options: WorkflowOptions) => Promise<void>,
) {
  const cwd = await mkdtemp(join(tmpdir(), "xh-native-task-"));
  try {
    await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
    const options = fixtureWorkflowOptions(cwd, {
      simulated: true,
      approve: async () => true,
      save: async () => {},
      agents: fixtureAgents("claude", false).agents,
    });
    await run(cwd, options);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
  }
}
it("runs without Git, existing tests or Vitest; preserves unrelated preexisting edits and records honest validation", async () =>
  fixture(async (cwd, options) => {
    await writeFile(join(cwd, "unrelated.txt"), "preexisting user edits");
    await writeFile(join(cwd, ".gitattributes"), "*.mjs diff=custom\n");
    const result = await runNativeTask(options, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(result.cwd).toBe(cwd);
    expect(result.calls.map((c) => c.phase)).toEqual([
      "plan",
      "implement",
      "review",
    ]);
    expect(result.checks).toEqual([]);
    expect(result.commits).toEqual([]);
    expect(result.answer).toContain("テスト実行報告なし");
    expect(officialWorkflowReport(result)).toContain(
      "ハーネス独立検証ではありません",
    );
    expect(resumeBlockReason(result)).toBe("native-work-resume-not-supported");
    expect(await readFile(join(cwd, "unrelated.txt"), "utf8")).toBe(
      "preexisting user edits",
    );
    await expect(access(join(cwd, ".git"))).rejects.toThrow();
  }));
it("review findings cause one correction; persistent failures stop after two corrections and seven phase calls", async () =>
  fixture(async (cwd, options) => {
    options.agents = fixtureAgents("claude", true).agents;
    const once = await runNativeTask(options, new AbortController().signal);
    expect(once.status).toBe("completed");
    expect(once.correctionRounds).toBe(1);
    const agent = options.agents.claude,
      original = agent.run.bind(agent);
    agent.run = async (request, signal) => {
      const result = await original(request, signal);
      if (["implement", "fix"].includes(request.phase))
        result.output = {
          summary: "validation failed",
          tests: [
            {
              command: "project test",
              status: "failed",
              summary: "mock failure",
            },
          ],
        };
      return result;
    };
    await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
    const failure = await runNativeTask(options, new AbortController().signal);
    expect(failure.status).toBe("attention");
    expect(failure.correctionRounds).toBe(2);
    expect(failure.calls).toHaveLength(7);
  }));
it.each(["deny", "cancel", "changed"])(
  "does not edit or test when plan approval is %s",
  async (kind) =>
    fixture(async (cwd, options) => {
      const controller = new AbortController();
      options.approve = async () => {
        if (kind === "cancel") controller.abort();
        if (kind === "changed")
          await writeFile(join(cwd, "add.mjs"), "user changed while waiting");
        return kind !== "deny";
      };
      const result = await runNativeTask(options, controller.signal);
      expect(result.status).toBe(kind === "cancel" ? "cancelled" : "failed");
      expect(result.calls.map((c) => c.phase)).toEqual(["plan"]);
      expect(await readFile(join(cwd, "add.mjs"), "utf8")).not.toContain("a+b");
    }),
);
it("invalid planning, same-company review and unchanged implementations fail once", async () =>
  fixture(async (_cwd, options) => {
    const agent = options.agents.claude,
      original = agent.run.bind(agent);
    for (const mode of ["invalid", "same-company", "no-change"]) {
      agent.run = async (request, signal) => {
        if (request.phase === "implement" && mode === "no-change")
          return {
            status: "completed",
            dispatched: true,
            observedModels: [],
            usage: null,
            elapsedMs: 0,
            output: { summary: "no edit", tests: [] },
          };
        const result = await original(request, signal);
        if (request.phase === "plan") {
          if (mode === "invalid") result.output = {};
          if (mode === "same-company")
            (
              result.output as {
                tasks: { reviewer: unknown; assignee: unknown }[];
              }
            ).tasks[0]!.reviewer = (
              result.output as { tasks: { assignee: unknown }[] }
            ).tasks[0]!.assignee;
        }
        return result;
      };
      const result = await runNativeTask(options, new AbortController().signal);
      expect(result.status).toBe("failed");
      expect(result.calls).toHaveLength(mode === "no-change" ? 2 : 1);
    }
  }));
it("captures only request changes, skips credential files and links, and persists initial snapshot failure", async () =>
  fixture(async (cwd, options) => {
    await writeFile(join(cwd, "auth.json"), "DUMMY_SECRET");
    const before = await nativeSnapshot(cwd, new AbortController().signal);
    expect(before.files.has("auth.json")).toBe(false);
    await writeFile(join(cwd, "new.ts"), "new file");
    const after = await nativeSnapshot(cwd, new AbortController().signal);
    expect(nativeDiff(before, after).files).toEqual(["new.ts"]);
    const link = `${cwd}-link`;
    await symlink(cwd, link, process.platform === "win32" ? "junction" : "dir");
    try {
      let saved: WorkflowRecord | undefined;
      options.cwd = link;
      options.save = async (r) => {
        saved = r;
      };
      const result = await runNativeTask(options, new AbortController().signal);
      expect(result.status).toBe("failed");
      expect(saved?.error).toBe("linked-workspace");
      expect(result.calls).toHaveLength(0);
    } finally {
      await rm(link);
    }
  }));
