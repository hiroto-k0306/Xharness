import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectVitest, VITEST_RUNNER } from "./project-vitest.js";
import { inspectProjectInventory } from "./project-inventory.js";
import { testDependencies } from "./test-dependencies.js";
import { runAcceptance } from "./workspace.js";

const roots: string[] = [],
  signal = () => new AbortController().signal;
afterEach(async () => {
  for (const r of roots.splice(0))
    await rm(r, { recursive: true, force: true, maxRetries: 5 });
});
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "xh-vitest-project-"));
  roots.push(dir);
  return dir;
}
async function fixture() {
  const cwd = await root();
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ type: "module", devDependencies: { vitest: "5.0.3" } }),
  );
  await writeFile(
    join(cwd, "acceptance.test.ts"),
    "import { expect, it } from 'vitest'; const input:number=2; it('typed arithmetic',()=>expect(input+3).toBe(5));\n",
  );
  return cwd;
}
it("discovers TypeScript only with declared Vitest, while excluding helpers", async () => {
  const cwd = await fixture();
  await mkdir(join(cwd, "test/fixtures"), { recursive: true });
  await writeFile(
    join(cwd, "test/fixtures/helper.test.ts"),
    "throw Error('not a test candidate');",
  );
  expect((await inspectProjectInventory(cwd, signal())).tests).toEqual([
    "acceptance.test.ts",
  ]);
  await rm(join(cwd, "package.json"));
  expect((await inspectProjectInventory(cwd, signal())).tests).toEqual([]);
});
it("refuses missing installed dependencies and TypeScript without declared Vitest", async () => {
  const cwd = await fixture();
  await expect(
    projectVitest(
      await inspectProjectInventory(cwd, signal()),
      "acceptance.test.ts",
      process.execPath,
      signal(),
    ),
  ).rejects.toThrow();
  await writeFile(join(cwd, "package.json"), "{}");
  await expect(
    projectVitest(
      await inspectProjectInventory(cwd, signal()),
      "acceptance.test.ts",
      process.execPath,
      signal(),
    ),
  ).rejects.toThrow("declared-installed-vitest-required");
});
it("copies dependencies without scripts, detects changed copies and rejects external links", async () => {
  const cwd = await root(),
    destination = await root(),
    pkg = join(cwd, "node_modules/fixture-pkg");
  await mkdir(pkg, { recursive: true });
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "fixture-pkg",
      version: "1.0.0",
      scripts: { postinstall: "never execute" },
    }),
  );
  await writeFile(join(pkg, "index.js"), "export const value=1;\n");
  const prepared = await testDependencies(cwd, ["fixture-pkg"], signal());
  const verify = await prepared.materialize(destination, signal());
  await verify();
  await writeFile(
    join(destination, "node_modules/fixture-pkg/index.js"),
    "changed",
  );
  await expect(verify()).rejects.toThrow("test-dependencies-changed");
  expect(await readFile(join(pkg, "index.js"), "utf8")).toContain("value=1");
  await writeFile(join(pkg, "auth.json"), "DO_NOT_COPY");
  await expect(
    testDependencies(cwd, ["fixture-pkg"], signal()),
  ).rejects.toThrow("unsafe-test-dependency-file");
  await rm(join(pkg, "auth.json"));
  const other = await root();
  await writeFile(
    join(other, "package.json"),
    JSON.stringify({ name: "external", version: "1" }),
  );
  await symlink(
    other,
    join(cwd, "node_modules/external"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(testDependencies(cwd, ["external"], signal())).rejects.toThrow(
    "external-test-dependency",
  );
});
it("runs exactly one real TypeScript Vitest file from copied dependencies; rejects settings and runner edits", async () => {
  const cwd = await fixture(),
    destination = await root();
  await writeFile(
    join(cwd, "vitest.config.ts"),
    "export default { test: { include: ['**/*.test.ts'] } };\n",
  );
  await writeFile(
    join(cwd, "other.test.ts"),
    "throw Error('unapproved test must not execute');",
  );
  const inventory = await inspectProjectInventory(cwd, signal());
  const prepared = (await projectVitest(
    inventory,
    "acceptance.test.ts",
    process.execPath,
    signal(),
    process.cwd(),
  ))!;
  expect(prepared.setup.kind).toBe("vitest");
  expect(prepared.setup.settings.map((f) => f.path)).toContain(
    "vitest.config.ts",
  );
  expect(prepared.setup.dependencies.files).toBeGreaterThan(0);
  await cp(cwd, destination, { recursive: true });
  const guard = await prepared.prepare(destination, signal());
  await guard();
  const result = await runAcceptance(
    destination,
    prepared.test,
    signal(),
    (s) => s,
  );
  expect(result, result.output).toMatchObject({
    passed: true,
    exitCode: 0,
  });
  await guard();
  await writeFile(
    join(destination, "vitest.config.ts"),
    "export default {};\n",
  );
  await expect(guard()).rejects.toThrow("test-settings-changed");
  await cp(
    join(cwd, "vitest.config.ts"),
    join(destination, "vitest.config.ts"),
  );
  await writeFile(
    join(destination, "node_modules/.xharness-vitest-runner.mjs"),
    "process.exit(0);",
  );
  await expect(guard()).rejects.toThrow("test-runner-changed");
}, 120000);

it.each([
  "no-tests",
  "extra-file",
  "all-skipped",
  "unhandled-error",
  "missing-dependency",
])(
  "refuses %s without installing dependencies or running an unapproved file",
  async (kind) => {
    const cwd = await root(),
      pkg = join(cwd, "node_modules/vitest");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(cwd, "package.json"), "{}");
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({
        name: "vitest",
        version: "5.0.3",
        type: "module",
        exports: { "./node": "./node.mjs" },
      }),
    );
    const api = `import { resolve } from 'node:path'; import { writeFile } from 'node:fs/promises';
  export async function createVitest(a,b,options) {
    const kind=${JSON.stringify(kind)},target=resolve('acceptance.test.ts');
    if(kind==='missing-dependency') await options.packageInstaller.ensureInstalled('xharness-not-installed-package');
    return {standalone:async()=>{},close:async()=>{},globTestSpecifications:async()=>kind==='no-tests'?[]:[{moduleId:kind==='extra-file'?target+'.other':target,project:{config:{}}}],
      runTestSpecifications:async()=>{await writeFile('ran-marker','fixture');return {unhandledErrors:kind==='unhandled-error'?[{}]:[],testModules:[{moduleId:target,state:()=> 'passed',children:{allTests:()=>[{result:()=>({state:kind==='all-skipped'?'skipped':'passed'})}]}}]};}};
  }`;
    await writeFile(join(pkg, "node.mjs"), api);
    await writeFile(
      join(cwd, "node_modules/.xharness-vitest-runner.mjs"),
      VITEST_RUNNER,
    );
    const result = await runAcceptance(
      cwd,
      {
        id: "api-boundary",
        program: process.execPath,
        args: [
          "node_modules/.xharness-vitest-runner.mjs",
          "acceptance.test.ts",
        ],
        command: "fixed",
        timeoutMs: 30000,
      },
      signal(),
      (s) => s,
    );
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    if (["no-tests", "extra-file", "missing-dependency"].includes(kind))
      await expect(readFile(join(cwd, "ran-marker"))).rejects.toThrow();
  },
);
