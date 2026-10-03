import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { decidePermission } from "./permissions.js";
import { runGit } from "../session/repository.js";
const exec = promisify(execFile);
it.each(["git status", "git diff", "git log", "git show"])(
  "requires confirmation for %s even with a broad allow",
  async (command) => {
    for (const mode of ["plan", "default", "acceptEdits"] as const)
      expect(
        await decidePermission(
          { id: "test", name: "Bash", input: { command } },
          { mode, rules: [{ tool: "Bash", decision: "allow" }] },
          process.cwd(),
        ),
      ).toBe("ask");
  },
);
it.each([
  "git diff --ext-diff",
  "git show --textconv",
  "git -c core.pager=echo log",
])("does not auto-allow %s", async (command) => {
  for (const mode of ["plan", "default"] as const)
    expect(
      await decidePermission(
        { id: "test", name: "Bash", input: { command } },
        { mode, rules: [{ tool: "Bash", decision: "allow" }] },
        process.cwd(),
      ),
    ).toBe(mode === "plan" ? "deny" : "ask");
});
it("allows ordinary non-Git reads and keeps explicit denies", async () => {
  expect(
    await decidePermission(
      { id: "test", name: "Bash", input: { command: "pwd" } },
      { mode: "plan", rules: [] },
      process.cwd(),
    ),
  ).toBe("allow");
  expect(
    await decidePermission(
      { id: "test", name: "Bash", input: { command: "git status" } },
      { mode: "plan", rules: [{ tool: "Bash", decision: "deny" }] },
      process.cwd(),
    ),
  ).toBe("deny");
});
it("demonstrates fsmonitor execution in an isolated repository before requiring confirmation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-fsmonitor-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  const git = (args: string[]) => exec("git", args, { cwd, env });
  await git(["init"]);
  await writeFile(
    join(cwd, "dummy-monitor"),
    "#!/bin/sh\nprintf safe > monitor-ran\nprintf 'token\\0'\n",
    { mode: 0o755 },
  );
  await git(["config", "core.fsmonitor", "./dummy-monitor"]);
  expect(
    await decidePermission(
      {
        id: "test",
        name: "Bash",
        input: { command: "git status --porcelain" },
      },
      { mode: "plan", rules: [] },
      cwd,
    ),
  ).toBe("ask");
  // Only this explicit local test executes the harmless script; no model or tool gate runs.
  await runGit(["status", "--porcelain"], cwd, new AbortController().signal);
  await expect(readFile(join(cwd, "monitor-ran"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await git(["status", "--porcelain"]);
  expect(await readFile(join(cwd, "monitor-ran"), "utf8")).toBe("safe");
});
it.each(["external", "textconv"])(
  "requires confirmation for plain diff with a configured %s helper",
  async (helper) => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-git-helper-"));
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    };
    const git = (args: string[]) => exec("git", args, { cwd, env });
    await git(["init"]);
    await writeFile(
      join(cwd, "dummy-diff"),
      "#!/bin/sh\nprintf safe > helper-ran\nprintf dummy\n",
      { mode: 0o755 },
    );
    await writeFile(join(cwd, ".gitattributes"), "*.txt diff=dummy\n");
    await writeFile(join(cwd, "a.txt"), "before\n");
    await git(["add", "a.txt"]);
    await writeFile(join(cwd, "a.txt"), "after\n");
    await git([
      "config",
      helper === "external" ? "diff.external" : "diff.dummy.textconv",
      "./dummy-diff",
    ]);
    expect(
      await decidePermission(
        { id: "test", name: "Bash", input: { command: "git diff" } },
        { mode: "plan", rules: [{ tool: "Bash", decision: "allow" }] },
        cwd,
      ),
    ).toBe("ask");
    await git(["diff"]);
    expect(await readFile(join(cwd, "helper-ran"), "utf8")).toBe("safe");
  },
);
