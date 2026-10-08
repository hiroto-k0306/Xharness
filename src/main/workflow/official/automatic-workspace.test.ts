import { afterEach, expect, it } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { automaticWorkspace } from "./automatic-workspace.js";
import { inspectProjectInventory } from "./project-inventory.js";
import { workflowGitEnvironment, workflowGitPolicyArgs } from "./workspace.js";

const exec = promisify(execFile),
  roots: string[] = [];
const scope = { files: ["add.mjs"], testFile: "acceptance.test.mjs" };
const signal = () => new AbortController().signal;
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
});
async function fixture(git = false) {
  const root = await mkdtemp(join(tmpdir(), "xh-auto-workspace-"));
  roots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd);
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
  await writeFile(join(cwd, "acceptance.test.mjs"), "import './add.mjs';\n");
  const run = (args: string[]) =>
    exec("git", [...workflowGitPolicyArgs(), ...args], {
      cwd,
      env: workflowGitEnvironment(),
      windowsHide: true,
    });
  if (git) {
    await run(["init"]);
    await run(["add", "."]);
    await run([
      "-c",
      "user.name=fixture",
      "-c",
      "user.email=fixture@local",
      "commit",
      "-m",
      "baseline",
    ]);
  }
  return { cwd, run };
}
it("defers Git worktree creation and leaves the original branch and files untouched without a remote", async () => {
  const f = await fixture(true),
    inventory = await inspectProjectInventory(f.cwd, signal());
  const before = (await f.run(["rev-parse", "HEAD"])).stdout;
  const prepared = await automaticWorkspace(
    inventory,
    scope,
    randomUUID(),
    signal(),
  );
  await expect(access(prepared.preparation.destination)).rejects.toThrow();
  await expect(
    prepared.workspace.commit(scope.files, signal()),
  ).rejects.toThrow("workspace-not-approved");
  const result = await prepared.prepare();
  expect(result.head).toBe(before.trim());
  expect(result.cwd).not.toBe(f.cwd);
  expect((await f.run(["rev-parse", "HEAD"])).stdout).toBe(before);
  expect((await f.run(["status", "--porcelain"])).stdout).toBe("");
  expect(await readFile(join(result.cwd, "add.mjs"), "utf8")).toContain("a-b");
  await expect(prepared.prepare()).rejects.toThrow(
    "workspace-preparation-already-started",
  );
});
it("creates the unversioned working copy inside the selected folder and initializes Git only there", async () => {
  const f = await fixture();
  const inventory = await inspectProjectInventory(f.cwd, signal());
  const prepared = await automaticWorkspace(
    inventory,
    scope,
    randomUUID(),
    signal(),
  );
  expect(dirname(dirname(prepared.preparation.destination))).toBe(f.cwd);
  await expect(access(join(f.cwd, ".git"))).rejects.toThrow();
  const result = await prepared.prepare();
  expect(await result.workspace.inspect(signal())).toMatchObject({
    clean: true,
  });
  await access(join(result.cwd, ".git"));
  await expect(access(join(f.cwd, ".git"))).rejects.toThrow();
  await writeFile(
    join(result.cwd, "add.mjs"),
    "export const add=(a,b)=>a+b;\n",
  );
  expect(await readFile(join(f.cwd, "add.mjs"), "utf8")).toContain("a-b");
  const head = await result.workspace.commit(scope.files, signal());
  expect(
    (await result.workspace.snapshot(result.head, head, signal())).files,
  ).toEqual(["add.mjs"]);
});
it("refuses changed sources, unknown tests and cancellation before creating a destination", async () => {
  const f = await fixture();
  const inventory = await inspectProjectInventory(f.cwd, signal());
  await expect(
    automaticWorkspace(
      inventory,
      { ...scope, testFile: "missing.test.mjs" },
      randomUUID(),
      signal(),
    ),
  ).rejects.toThrow("existing-independent-test-required");
  const prepared = await automaticWorkspace(
    inventory,
    scope,
    randomUUID(),
    signal(),
  );
  await writeFile(join(f.cwd, "add.mjs"), "changed");
  await expect(prepared.prepare()).rejects.toThrow(
    "project-changed-after-inspection",
  );
  await expect(access(prepared.preparation.destination)).rejects.toThrow();
  const controller = new AbortController();
  const other = await fixture();
  const cancelled = await automaticWorkspace(
    await inspectProjectInventory(other.cwd, signal()),
    scope,
    randomUUID(),
    controller.signal,
  );
  controller.abort();
  await expect(cancelled.prepare()).rejects.toThrow();
  await expect(access(cancelled.preparation.destination)).rejects.toThrow();
});

it("reuses a verified session worktree and refuses a dirty Git source", async () => {
  const f = await fixture(true),
    existing = join(dirname(f.cwd), "existing");
  await f.run(["worktree", "add", "--detach", existing]);
  const reused = await automaticWorkspace(
    await inspectProjectInventory(existing, signal()),
    scope,
    randomUUID(),
    signal(),
    f.cwd,
  );
  expect(reused.preparation.kind).toBe("reuse-worktree");
  expect((await reused.prepare()).cwd).toBe(existing);
  await writeFile(join(f.cwd, "add.mjs"), "dirty");
  await expect(
    automaticWorkspace(
      await inspectProjectInventory(f.cwd, signal()),
      scope,
      randomUUID(),
      signal(),
    ),
  ).rejects.toThrow("作業の準備を停止");
});
