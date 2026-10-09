import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileAccess } from "./file-access.js";

const roots: string[] = [];
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "xh-file-access-"));
  roots.push(cwd);
  return { cwd, access: new FileAccess(cwd) };
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it("binds snapshots to canonical targets and rejects credential names and symlink aliases", async () => {
  const { cwd, access } = await fixture();
  const path = join(cwd, "file");
  await writeFile(path, "before");
  await symlink(path, join(cwd, "alias"));
  expect(await access.path("alias")).toBe(await access.path("file"));
  for (const name of ["auth.json", ".credentials.json", "AUTH.JSON"]) {
    await expect(access.path(name)).rejects.toThrow("Credential");
  }
  await writeFile(join(cwd, "auth.json"), "never read");
  await symlink(join(cwd, "auth.json"), join(cwd, "innocent"));
  await expect(access.path("innocent")).rejects.toThrow("Credential");
  await mkdir(join(cwd, "folder"));
  await symlink(
    join(cwd, "folder"),
    join(cwd, "folder-alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(await access.path("folder-alias/new-file")).toBe(
    await access.path("folder/new-file"),
  );
});
it("requires an observed snapshot and detects changes and disappearance without accepting stale reads", async () => {
  const { cwd, access } = await fixture();
  const path = await access.path("file");
  expect(await access.check(path)).toBeUndefined();
  await writeFile(path, "before");
  expect(await access.check(path)).toContain("Read");
  const snapshot = await access.snapshot(path);
  expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
  access.reads.set(path, snapshot);
  expect(await access.check(path)).toBeUndefined();
  await writeFile(path, "after");
  expect(await access.check(path)).toContain("changed");
  await rm(join(cwd, "file"));
  expect(await access.check(path)).toContain("disappeared");
});
