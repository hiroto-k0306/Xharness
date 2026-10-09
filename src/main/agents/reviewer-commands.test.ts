import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  reviewerCommandAllowed,
  reviewerCommandError,
  reviewerTestHint,
} from "./reviewer-commands.js";

const directories: string[] = [];
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "xh-reviewer-"));
  directories.push(cwd);
  return cwd;
}
async function put(cwd: string, path: string, content = "") {
  const file = join(cwd, path);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, content);
}
function recommendedCommand(hint: string) {
  const match = /defines a test script: run `([^`]+)`/.exec(hint);
  expect(match).not.toBeNull();
  const command = match![1]!;
  expect(reviewerCommandAllowed(command)).toBe(true);
  return command;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((cwd) => rm(cwd, { recursive: true, force: true })),
  );
});

const wrappers = [".\\scripts\\pnpm.ps1", "./scripts/pnpm.ps1"];
const scripts = ["test", "lint", "typecheck", "build"];

describe("reviewer Bash (test commands only)", () => {
  it.each([
    "npm test",
    "pnpm test",
    "pnpm run lint",
    "yarn test",
    "npx vitest run",
    "node --test",
    "pytest -q",
    ...wrappers.flatMap((wrapper) =>
      scripts.flatMap((script) => [
        `${wrapper} ${script}`,
        `${wrapper} run ${script}`,
      ]),
    ),
  ])("allows %s", (command) =>
    expect(reviewerCommandAllowed(command)).toBe(true),
  );
  it.each([
    // 安定化の通し確認で実際に拒否された2件
    "Set-Location D:\\work\\sample; node sum.test.js; git diff --name-only",
    "node sum.test.js",
    "npm test; Remove-Item x",
    "npm test (calc)",
    "npm install",
    "node -e process.exit(0)",
    // Fixed paths only; no absolute paths, traversal, arbitrary scripts or launchers.
    "C:\\work\\scripts\\pnpm.ps1 test",
    "/work/scripts/pnpm.ps1 test",
    "../scripts/pnpm.ps1 test",
    ".\\scripts\\..\\pnpm.ps1 test",
    ".\\scripts\\danger.ps1 test",
    ".\\scripts\\pnpm.ps1.exe test",
    ".\\.tools\\node_modules\\.bin\\pnpm.cmd test",
    "pwsh -File ./scripts/pnpm.ps1 test",
    "& .\\scripts\\pnpm.ps1 test",
    ". .\\scripts\\pnpm.ps1 test",
    ...wrappers.flatMap((wrapper) =>
      [
        "install",
        "exec node evil.js",
        "run evil",
        "run test:evil",
        "test:evil",
        "package",
        "release",
        "--dir ../outside test",
        "test --dir ../outside",
        "test ../evil.ps1",
        "test -File C:\\evil.ps1",
        "test; Remove-Item x",
        "test && calc",
        "test | Out-File x",
        "test > x",
        "test < x",
        "test\ncalc",
        "test\rcalc",
        "test $env:PATH",
        "test $(calc)",
        "test `ncalc",
        "test (calc)",
        "test {calc}",
        "test @('calc')",
        'test "calc"',
        "test 'calc'",
        "test # comment",
      ].map((tail) => `${wrapper} ${tail}`),
    ),
  ])("rejects %s", (command) =>
    expect(reviewerCommandAllowed(command)).toBe(false),
  );
  it("explains what is allowed when it rejects", () => {
    expect(reviewerCommandError()).toContain("npm test");
    expect(reviewerCommandError()).toContain("no cd");
    for (const wrapper of wrappers) {
      expect(reviewerCommandError()).toContain(wrapper);
    }
    expect(reviewerCommandError()).toContain("no extra arguments");
  });
  it("tells the reviewer which test command this project uses", async () => {
    const cwd = await workspace();
    expect(await reviewerTestHint(cwd)).not.toContain("defines a test script");
    await put(
      cwd,
      "package.json",
      JSON.stringify({ scripts: { test: "node sum.test.js" } }),
    );
    expect(recommendedCommand(await reviewerTestHint(cwd))).toBe("npm test");
    await put(cwd, "pnpm-lock.yaml");
    expect(recommendedCommand(await reviewerTestHint(cwd))).toBe("pnpm test");
  });
  it.each([
    ["win32", true, true, ".\\scripts\\pnpm.ps1 test"],
    ["win32", false, true, "pnpm test"],
    ["win32", true, false, "pnpm test"],
    ["win32", false, false, "pnpm test"],
    ["linux", true, true, "pnpm test"],
    ["darwin", true, true, "pnpm test"],
  ] as const)(
    "recommends %s local pnpm=%s wrapper=%s: %s",
    async (platform, local, wrapper, expected) => {
      const cwd = await workspace();
      await put(
        cwd,
        "package.json",
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      await put(cwd, "pnpm-lock.yaml");
      if (local) await put(cwd, ".tools/node_modules/.bin/pnpm.cmd");
      if (wrapper) await put(cwd, "scripts/pnpm.ps1");
      expect(recommendedCommand(await reviewerTestHint(cwd, platform))).toBe(
        expected,
      );
    },
  );
  it("does not require a lockfile to recognize the local Windows wrapper", async () => {
    const cwd = await workspace();
    await put(
      cwd,
      "package.json",
      JSON.stringify({ scripts: { test: "vitest run" } }),
    );
    await put(cwd, ".tools/node_modules/.bin/pnpm.cmd");
    await put(cwd, "scripts/pnpm.ps1");
    expect(recommendedCommand(await reviewerTestHint(cwd, "win32"))).toBe(
      ".\\scripts\\pnpm.ps1 test",
    );
  });
  it.each([".tools/node_modules/.bin/pnpm.cmd", "scripts/pnpm.ps1"])(
    "does not recommend the wrapper if %s is a directory",
    async (directory) => {
      const cwd = await workspace();
      await put(
        cwd,
        "package.json",
        JSON.stringify({ scripts: { test: "vitest run" } }),
      );
      await put(cwd, "pnpm-lock.yaml");
      for (const path of [
        ".tools/node_modules/.bin/pnpm.cmd",
        "scripts/pnpm.ps1",
      ]) {
        if (path === directory)
          await mkdir(join(cwd, path), { recursive: true });
        else await put(cwd, path);
      }
      expect(recommendedCommand(await reviewerTestHint(cwd, "win32"))).toBe(
        "pnpm test",
      );
    },
  );
  it("does not recommend a test without a test script", async () => {
    const cwd = await workspace();
    await put(
      cwd,
      "package.json",
      JSON.stringify({ scripts: { lint: "eslint ." } }),
    );
    await put(cwd, ".tools/node_modules/.bin/pnpm.cmd");
    await put(cwd, "scripts/pnpm.ps1");
    expect(await reviewerTestHint(cwd, "win32")).not.toContain(
      "defines a test script",
    );
  });
});
