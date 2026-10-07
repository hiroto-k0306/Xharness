import { afterEach, expect, it, vi } from "vitest";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createDagWorkspace } from "./dag-fixtures.js";
import { OfficialWorktrees } from "./worktrees.js";
import { gitWorkspace } from "./workspace.js";

const homes: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) {
    const target = await realpath(home),
      base = await realpath(tmpdir());
    const rel = relative(base, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("unsafe test cleanup");
    await rm(target, { recursive: true, force: true, maxRetries: 5 });
  }
});

it("creates and integrates clean LF worktrees despite external autocrlf=true", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-worktree-config-"));
  homes.push(home);
  const config = "[core]\n autocrlf = true\n";
  await writeFile(join(home, ".gitconfig"), config);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
  const { owned, cwd } = await createDagWorkspace(home);
  const root = gitWorkspace(cwd, (s) => s),
    base = await root.inspect(signal());
  expect(base.clean).toBe(true);
  const worktrees = new OfficialWorktrees(cwd, owned, (s) => s);
  const childPath = await worktrees.create(base.head, signal());
  const child = await worktrees.open(childPath, signal());
  expect(await child.inspect(signal())).toEqual(base);
  expect(await readFile(join(childPath, "add.mjs"), "utf8")).not.toContain(
    "\r",
  );
  await writeFile(join(childPath, "add.mjs"), "export const add=(a,b)=>a+b;\n");
  const head = await child.commit(["add.mjs"], signal());
  const integrated = await worktrees.integrate(
    childPath,
    base.head,
    head,
    base.head,
    ["add.mjs"],
    signal(),
  );
  expect(await root.inspect(signal())).toEqual({
    head: integrated,
    clean: true,
  });
  expect(await worktrees.history(base.head, integrated, signal())).toHaveLength(
    1,
  );
  expect(await readFile(join(cwd, "add.mjs"), "utf8")).toBe(
    "export const add=(a,b)=>a+b;\n",
  );
  expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe(config);
});

it("rejects local includes introduced before creating a managed worktree", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-worktree-local-"));
  homes.push(home);
  const { owned, cwd } = await createDagWorkspace(home);
  const base = await gitWorkspace(cwd, (s) => s).inspect(signal());
  await appendFile(
    join(cwd, ".git/config"),
    "\n[include]\n path = ../missing.conf\n",
  );
  const worktrees = new OfficialWorktrees(cwd, owned, (s) => s);
  await expect(worktrees.create(base.head, signal())).rejects.toThrow(
    "local-git-execution-configuration",
  );
  expect(await readdir(worktrees.root)).toEqual([]);
});
