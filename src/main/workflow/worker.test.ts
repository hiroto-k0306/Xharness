import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { WorkerExecutor } from "./worker.js";
import { ChildRunner } from "../agents/runner.js";
import { Changes } from "./changes.js";
import { Router } from "../core/router.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { runGit } from "../session/repository.js";
import { defaultTools } from "../session/controller.js";

const call = (name: string, input: unknown): FakeStep => ({
  type: "message",
  stopReason: "tool_use",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: name, name, input }],
  },
});
it("keeps a real merge conflict and worker branch for main, instead of overwriting or removing them", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-worker-conflict-"));
  const signal = new AbortController().signal;
  const git = (args: string[]) => runGit(args, home, signal);
  const commit = async (message: string) => {
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      message,
    ]);
  };
  await git(["init", "-b", "session"]);
  await writeFile(join(home, "shared.txt"), "base\n");
  await commit("base");
  let workerNewline = "\n";
  const provider = new FakeProvider({
    provider: "codex",
    script: [
      call("Read", { path: "shared.txt" }),
      call("MultiEdit", {
        path: "shared.txt",
        edits: [{ old: "base", new: "worker" }],
      }),
      call("ReportDone", {
        summary: "done",
        changedFiles: ["shared.txt"],
        testsRun: [],
      }),
    ],
  });
  // State must sit outside the source repository so its histories aren't changes.
  const state = await mkdtemp(join(tmpdir(), "xh-conflict-state-"));
  const separate = new ChildRunner({
    ...{
      home: state,
      parentId: "conflict",
      router: new Router([provider]),
      createTools: (cwd: string) => defaultTools(cwd, false),
    },
    permission: async (call, context) => {
      if (call.name === "Read")
        workerNewline =
          /\r?\n/.exec(
            await readFile(join(context.cwd, "shared.txt"), "utf8"),
          )?.[0] ?? "\n";
      if (call.name === "ReportDone") {
        await writeFile(join(home, "shared.txt"), "main\n");
        await commit("main change");
      }
      return true;
    },
  });
  const executor = new WorkerExecutor({
    home: state,
    sessionId: "conflict",
    cwd: home,
    runner: separate,
    worktrees: true,
    changes: new Changes(home),
  });
  await expect(
    executor.run(
      {
        id: "P1",
        title: "Shared",
        instructions: "Change shared.txt",
        files: ["shared.txt"],
        dependsOn: [],
        assignee: {
          agent: "worker",
          model: "codex:sol",
          effort: "high",
          reason: "Test",
        },
        acceptance: "Changed",
      },
      signal,
    ),
  ).rejects.toThrow("Git operation failed");
  expect(await git(["diff", "--name-only", "--diff-filter=U"])).toBe(
    "shared.txt",
  );
  expect(
    await readFile(
      join(state, "worktrees", "conflict", "conflict-w1", "shared.txt"),
      "utf8",
    ),
  ).toBe(`worker${workerNewline}`);
  expect(await git(["branch", "--list", "xh/conflict-w1"])).toContain(
    "xh/conflict-w1",
  );
}, 15000);
