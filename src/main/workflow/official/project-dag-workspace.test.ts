import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectDagWorkspace } from "./project-dag-workspace.js";
import { workflowGitEnvironment, workflowGitPolicyArgs } from "./workspace.js";
const exec = promisify(execFile),
  homes: string[] = [];
const signal = () => new AbortController().signal;
const approvalDigest = "a".repeat(64);
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "xharness-project-dag-test-"));
  homes.push(home);
  const cwd = join(home, "project"),
    ownedRoot = join(home, "owned");
  await mkdir(cwd);
  const git = async (...args: string[]) =>
    (
      await exec("git", [...workflowGitPolicyArgs(), ...args], {
        cwd,
        env: workflowGitEnvironment(),
      })
    ).stdout.trim();
  await git("init", "-b", "main");
  for (const name of ["a.txt", "b.txt", "c.txt", "same.txt"])
    await writeFile(join(cwd, name), `${name}: original\n`);
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@local",
    "commit",
    "-m",
    "baseline",
  );
  const baseHead = await git("rev-parse", "HEAD");
  return {
    cwd,
    ownedRoot,
    baseHead,
    git,
    create: () =>
      createProjectDagWorkspace({
        cwd,
        ownedRoot,
        baseHead,
        approvalDigest,
        signal: signal(),
      }),
  };
}
it("runs independent isolated tasks then builds a dependency base and owned integration without editing the user's branch", async () => {
  const f = await fixture(),
    session = await f.create();
  const [a, b] = await Promise.all([
    session.task("a", [], ["a.txt"]),
    session.task("b", [], ["b.txt"]),
  ]);
  expect(a.cwd).not.toBe(b.cwd);
  expect(a.baseHead).toBe(f.baseHead);
  expect(b.baseHead).toBe(f.baseHead);
  await Promise.all([
    writeFile(join(a.cwd, "a.txt"), "A completed\n"),
    writeFile(join(b.cwd, "b.txt"), "B completed\n"),
  ]);
  const commits = await Promise.all([
    a.commit({ approvalDigest, signal: signal() }),
    b.commit({ approvalDigest, signal: signal() }),
  ]);
  expect(commits[0]).not.toBe(commits[1]);
  const c = await session.task("c", ["a", "b"], ["c.txt"]);
  expect(await readFile(join(c.cwd, "a.txt"), "utf8")).toBe("A completed\n");
  expect(await readFile(join(c.cwd, "b.txt"), "utf8")).toBe("B completed\n");
  await writeFile(join(c.cwd, "c.txt"), "C sees dependencies\n");
  await c.commit({ approvalDigest, signal: signal() });
  const integrated = await session.integrate(["a", "b", "c"], {
    approvalDigest,
    signal: signal(),
  });
  expect(integrated.cwd).not.toBe(f.cwd);
  expect(
    (
      await integrated.workspace.snapshot(
        integrated.baseHead,
        integrated.head,
        signal(),
      )
    ).files.sort(),
  ).toEqual(["a.txt", "b.txt", "c.txt"]);
  expect(await readFile(join(integrated.cwd, "c.txt"), "utf8")).toBe(
    "C sees dependencies\n",
  );
  expect(await f.git("rev-parse", "HEAD")).toBe(f.baseHead);
  expect(await f.git("symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(await f.git("status", "--porcelain=v1", "--untracked-files=all")).toBe(
    "",
  );
  expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe(
    "a.txt: original\n",
  );
  expect(session.snapshots().tasks.map((task) => task.status)).toEqual([
    "completed",
    "completed",
    "completed",
  ]);
});
it.each([
  "dirty",
  "untracked",
  "non-git",
  "unsafe-config",
  "unsafe-attributes",
])("stops %s before creating owned worktrees", async (mode) => {
  const f = await fixture();
  if (mode === "dirty") await writeFile(join(f.cwd, "a.txt"), "user draft\n");
  if (mode === "untracked")
    await writeFile(join(f.cwd, "user.txt"), "user data\n");
  if (mode === "non-git") await rm(join(f.cwd, ".git"), { recursive: true });
  if (mode === "unsafe-config")
    await f.git("config", "filter.danger.smudge", "danger-not-executed");
  if (mode === "unsafe-attributes") {
    await writeFile(join(f.cwd, ".gitattributes"), "*.txt filter=unsafe\n");
    await f.git("add", ".gitattributes");
    await f.git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@local",
      "commit",
      "-m",
      "unsafe attribute fixture",
    );
  }
  await expect(f.create()).rejects.toThrow("project-dag-clean-git-required");
  expect(await readdir(f.ownedRoot).catch(() => [])).toEqual([]);
  if (mode === "dirty")
    expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe("user draft\n");
  if (mode === "untracked")
    expect(await readFile(join(f.cwd, "user.txt"), "utf8")).toBe("user data\n");
});
it("rejects changed approval and out-of-scope task edits without committing or cleaning them", async () => {
  const f = await fixture(),
    session = await f.create();
  const task = await session.task("task", [], ["a.txt"]);
  await writeFile(join(task.cwd, "a.txt"), "allowed\n");
  await writeFile(join(task.cwd, "b.txt"), "outside scope\n");
  await expect(
    task.commit({ approvalDigest: "b".repeat(64), signal: signal() }),
  ).rejects.toThrow("project-dag-approval-changed");
  await expect(
    task.commit({ approvalDigest, signal: signal() }),
  ).rejects.toThrow("scope-violation");
  expect((await task.workspace.inspect(signal())).head).toBe(f.baseHead);
  expect(await readFile(join(task.cwd, "b.txt"), "utf8")).toBe(
    "outside scope\n",
  );
  await expect(
    task.commit({ approvalDigest, signal: signal() }),
  ).rejects.toThrow("project-dag-task-in-flight-or-completed");
  expect(session.snapshots().tasks[0]!.status).toBe("uncertain");
});
it("preserves a real integration conflict and rejects retry rather than resetting or merging the user's branch", async () => {
  const f = await fixture(),
    session = await f.create();
  const [a, b] = await Promise.all([
    session.task("a", [], ["same.txt"]),
    session.task("b", [], ["same.txt"]),
  ]);
  await writeFile(join(a.cwd, "same.txt"), "independent A\n");
  await writeFile(join(b.cwd, "same.txt"), "independent B\n");
  await a.commit({ approvalDigest, signal: signal() });
  await b.commit({ approvalDigest, signal: signal() });
  await expect(
    session.integrate(["a", "b"], { approvalDigest, signal: signal() }),
  ).rejects.toThrow("project-dag-integration-conflict");
  const integration = session.snapshots().integration!;
  expect(integration.status).toBe("uncertain");
  expect(await readFile(join(integration.cwd, "same.txt"), "utf8")).toContain(
    "<<<<<<<",
  );
  await expect(
    session.integrate(["a", "b"], { approvalDigest, signal: signal() }),
  ).rejects.toThrow("project-dag-integration-in-flight-or-incomplete");
  expect(await f.git("rev-parse", "HEAD")).toBe(f.baseHead);
  expect(await readFile(join(f.cwd, "same.txt"), "utf8")).toBe(
    "same.txt: original\n",
  );
  expect(await readFile(join(a.cwd, "same.txt"), "utf8")).toBe(
    "independent A\n",
  );
});
it("rejects uncompleted dependencies, non-topological integration and user-root changes", async () => {
  const f = await fixture(),
    session = await f.create();
  const a = await session.task("a", [], ["a.txt"]);
  await expect(session.task("b", ["a"], ["b.txt"])).rejects.toThrow(
    "project-dag-dependency-not-completed",
  );
  await writeFile(join(a.cwd, "a.txt"), "A\n");
  await a.commit({ approvalDigest, signal: signal() });
  const b = await session.task("b", ["a"], ["b.txt"]);
  await writeFile(join(b.cwd, "b.txt"), "B\n");
  await b.commit({ approvalDigest, signal: signal() });
  await expect(
    session.integrate(["b", "a"], { approvalDigest, signal: signal() }),
  ).rejects.toThrow("project-dag-invalid-integration-order");
  await writeFile(join(f.cwd, "user-new.txt"), "manual user data\n");
  await expect(
    session.integrate(["a", "b"], { approvalDigest, signal: signal() }),
  ).rejects.toThrow("project-dag-source-changed");
  expect(await readFile(join(f.cwd, "user-new.txt"), "utf8")).toBe(
    "manual user data\n",
  );
});
it("rejects model/external commits rather than adopting them as harness-owned task results", async () => {
  const f = await fixture(),
    session = await f.create(),
    task = await session.task("a", [], ["a.txt"]);
  await writeFile(join(task.cwd, "a.txt"), "external\n");
  await exec("git", [...workflowGitPolicyArgs(), "add", "a.txt"], {
    cwd: task.cwd,
    env: workflowGitEnvironment(),
  });
  await exec(
    "git",
    [
      ...workflowGitPolicyArgs(),
      "-c",
      "user.name=External",
      "-c",
      "user.email=external@local",
      "commit",
      "-m",
      "external",
    ],
    { cwd: task.cwd, env: workflowGitEnvironment() },
  );
  await expect(
    task.commit({ approvalDigest, signal: signal() }),
  ).rejects.toThrow("project-dag-unowned-task-commit");
  expect(await f.git("rev-parse", "HEAD")).toBe(f.baseHead);
});

it("does not retry an integration interrupted before checkout and preserves completed task worktrees", async () => {
  const f = await fixture(),
    session = await f.create(),
    task = await session.task("a", [], ["a.txt"]);
  await writeFile(join(task.cwd, "a.txt"), "approved A\n");
  await task.commit({ approvalDigest, signal: signal() });
  const controller = new AbortController();
  controller.abort();
  await expect(
    session.integrate(["a"], { approvalDigest, signal: controller.signal }),
  ).rejects.toThrow();
  expect(session.snapshots().integration?.status).toBe("uncertain");
  const manifest = JSON.parse(
    await readFile(join(session.ownedDirectory, "manifest.json"), "utf8"),
  );
  expect(manifest.integration.status).toBe("uncertain");
  await expect(
    session.integrate(["a"], { approvalDigest, signal: signal() }),
  ).rejects.toThrow("project-dag-integration-in-flight-or-incomplete");
  expect(await readFile(join(task.cwd, "a.txt"), "utf8")).toBe("approved A\n");
  expect(await f.git("rev-parse", "HEAD")).toBe(f.baseHead);
});
it("rejects changed source branch identity even when its commit and files are unchanged", async () => {
  const f = await fixture(),
    session = await f.create();
  await f.git("checkout", "-b", "user-other-branch");
  await expect(session.task("a", [], ["a.txt"])).rejects.toThrow(
    "project-dag-source-changed",
  );
  expect(await f.git("symbolic-ref", "--short", "HEAD")).toBe(
    "user-other-branch",
  );
  expect(await f.git("rev-parse", "HEAD")).toBe(f.baseHead);
});

it("rejects substituted .git metadata before a task can stage or commit into the user checkout", async () => {
  const f = await fixture(),
    session = await f.create(),
    task = await session.task("a", [], ["a.txt"]);
  await writeFile(join(task.cwd, "a.txt"), "must stay owned\n");
  await writeFile(join(task.cwd, ".git"), `gitdir: ${join(f.cwd, ".git")}\n`);
  await expect(
    task.commit({ approvalDigest, signal: signal() }),
  ).rejects.toThrow("project-dag-unowned-worktree-metadata");
  await expect(task.workspace.commit(["a.txt"], signal())).rejects.toThrow(
    "project-dag-wrapper-commit-required",
  );
  expect(await f.git("rev-parse", "HEAD")).toBe(f.baseHead);
  expect(await f.git("status", "--porcelain=v1", "--untracked-files=all")).toBe(
    "",
  );
  expect(await readFile(join(f.cwd, "a.txt"), "utf8")).toBe(
    "a.txt: original\n",
  );
});
