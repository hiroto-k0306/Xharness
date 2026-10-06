import { it, expect, afterEach } from "vitest";
import { rm, writeFile, readFile, link } from "node:fs/promises";
import { join } from "node:path";
import { createSyntheticWorkspace } from "./fixtures.js";
import { gitWorkspace, scopedPath, runtimeEnvironment } from "./workspace.js";
import { relativeFile } from "./contracts.js";
const homes: string[] = [];
afterEach(async () => {
  for (const cwd of homes.splice(0))
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
});
const signal = () => new AbortController().signal;
it("preserves out-of-plan edits and refuses to commit the test", async () => {
  const cwd = await createSyntheticWorkspace();
  homes.push(cwd);
  const git = gitWorkspace(cwd, (s) => s),
    base = await git.inspect(signal());
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a+b;\n");
  await writeFile(join(cwd, "acceptance.test.mjs"), "tampered\n");
  await expect(git.commit(["add.mjs"], signal())).rejects.toThrow(
    "scope-violation",
  );
  expect((await git.inspect(signal())).head).toBe(base.head);
  expect(await readFile(join(cwd, "acceptance.test.mjs"), "utf8")).toBe(
    "tampered\n",
  );
});
it("rejects credential paths, traversal, binary and hardlinked changes", async () => {
  const cwd = await createSyntheticWorkspace();
  homes.push(cwd);
  for (const path of [
    "../auth.json",
    ".env",
    ".npmrc",
    ".netrc",
    ".git/config",
    "id_ecdsa",
    "auth.json",
    "key.pem",
  ]) {
    expect(relativeFile.safeParse(path).success).toBe(false);
    await expect(scopedPath(cwd, path)).rejects.toThrow();
  }
  const git = gitWorkspace(cwd, (s) => s);
  await writeFile(join(cwd, "add.mjs"), Buffer.from([0, 1, 2]));
  await expect(git.commit(["add.mjs"], signal())).rejects.toThrow(
    "secret-or-binary-change",
  );
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a+b;\n");
  await link(join(cwd, "add.mjs"), join(cwd, "linked.mjs"));
  await expect(git.commit(["add.mjs", "linked.mjs"], signal())).rejects.toThrow(
    "unsafe-change",
  );
});
it("strips provider keys and process injection from helper environment", () => {
  expect(
    runtimeEnvironment({
      PATH: "allowed",
      ANTHROPIC_API_KEY: "untrusted",
      OPENAI_API_KEY: "untrusted",
      NODE_OPTIONS: "--require injection",
      GIT_CONFIG_COUNT: "1",
    }),
  ).toEqual({ PATH: "allowed" });
});
