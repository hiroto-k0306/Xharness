import { it, expect, afterEach, vi } from "vitest";
import {
  rm,
  writeFile,
  readFile,
  link,
  mkdtemp,
  utimes,
  appendFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSyntheticWorkspace } from "./fixtures.js";
import { gitWorkspace, scopedPath, runtimeEnvironment } from "./workspace.js";
import { relativeFile } from "./contracts.js";
import { projectPreflight } from "./preflight.js";
const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cwd of homes.splice(0))
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 });
});
it("keeps global filters disabled from preflight through inspect and refuses filter attributes before commit", async () => {
  const cwd = await createSyntheticWorkspace(),
    home = await mkdtemp(join(tmpdir(), "xh-git-global-fixture-"));
  homes.push(cwd, home);
  const marker = join(home, "marker"),
    script = join(home, "probe.cjs");
  await writeFile(
    script,
    `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(fs.readFileSync(0));`,
  );
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`;
  const config = `[filter "probe"]\n\tclean = ${JSON.stringify(command)}\n`;
  await writeFile(join(home, ".gitconfig"), config);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, ".gitconfig"));
  await writeFile(join(cwd, ".git/info/attributes"), "add.mjs filter=probe\n");
  await utimes(join(cwd, "add.mjs"), new Date(1000000), new Date(1000000));
  expect(
    (await projectPreflight(cwd, ["add.mjs"], signal())).inspectionPassed,
  ).toBe(true);
  const git = gitWorkspace(cwd, (s) => s),
    initial = await git.inspect(signal());
  expect(initial.clean).toBe(true);
  await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a+b;\n");
  await expect(git.commit(["add.mjs"], signal())).rejects.toThrow(
    "git-filter-not-supported",
  );
  expect((await git.inspect(signal())).head).toBe(initial.head);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(cwd, ".git/info/attributes"), "");
  const head = await git.commit(["add.mjs"], signal());
  expect((await git.snapshot(initial.head, head, signal())).files).toEqual([
    "add.mjs",
  ]);
  await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(home, ".gitconfig"), "utf8")).toBe(config);
});
it.each(["include", "filter"])(
  "rejects %s introduced after inspection before the next Git command",
  async (kind) => {
    const cwd = await createSyntheticWorkspace();
    homes.push(cwd);
    const git = gitWorkspace(cwd, (s) => s);
    await git.inspect(signal());
    await appendFile(
      join(cwd, ".git/config"),
      kind === "include"
        ? "\n[include]\n path = ../missing.conf\n"
        : '\n[filter "late"]\n clean = never-execute-this\n',
    );
    const preserved = await readFile(join(cwd, ".git/config"), "utf8");
    await expect(git.inspect(signal())).rejects.toThrow(
      "local-git-execution-configuration",
    );
    await expect(git.commit(["add.mjs"], signal())).rejects.toThrow(
      "local-git-execution-configuration",
    );
    expect(await readFile(join(cwd, ".git/config"), "utf8")).toBe(preserved);
  },
);
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
