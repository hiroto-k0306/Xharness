import { readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { WorkflowFailure, type TestSpec } from "./contracts.js";
import {
  testDependencies,
  type DependencySnapshot,
} from "./test-dependencies.js";
import type { ProjectInventory } from "./project-inventory.js";
import { scopedPath } from "./workspace.js";
import { isBuiltin } from "node:module";
import ts from "typescript";

const sha = (text: string | Uint8Array) =>
  createHash("sha256").update(text).digest("hex");
export interface VitestSetup {
  kind: "vitest";
  version: string;
  config: string | null;
  settings: { path: string; hash: string }[];
  dependencies: DependencySnapshot;
  command: string;
}
// This runner uses the installed Vitest 5 public API. Filters are verified before
// executing a specification: substring matches, no tests and all-skipped fail.
export const VITEST_RUNNER = `import { createVitest } from 'vitest/node';
import { resolve, relative } from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const [test,config] = process.argv.slice(2), target=resolve(test);
const cache=await mkdtemp(resolve(tmpdir(),'xharness-vitest-cache-'));
const req=createRequire(resolve('package.json')), modules=resolve('node_modules');
const installed=name=>{try {const path=req.resolve(name), rel=relative(modules,path);return !!rel && !rel.startsWith('..') && !rel.includes(':');}catch{return false;}};
let ctx;
try {
  process.env.TEST='true'; process.env.VITEST='true'; process.env.NODE_ENV='test';
  ctx=await createVitest({root:process.cwd(),config:config || false,run:true,watch:false,maxWorkers:1,testTimeout:30000,retry:0,passWithNoTests:false,coverage:{enabled:false},ui:false,api:false,cache:false}, {configLoader:'runner',cacheDir:cache}, {packageInstaller:{isPackageExists:installed,ensureInstalled:async name=>{if(installed(name)) return true;throw Error('dependency-installation-disabled');}}});
  await ctx.standalone();
  const specs=await ctx.globTestSpecifications([target]);
  const same=path=>resolve(path).toLowerCase()===target.toLowerCase();
  if(!specs.length || specs.some(s=>!same(s.moduleId) || s.project.config.browser?.enabled)) throw Error('exact-test-scope-required');
  const result=await ctx.runTestSpecifications(specs);
  const tests=result.testModules.flatMap(m=>[...m.children.allTests()]);
  if(result.unhandledErrors.length || !tests.length || !tests.some(t=>t.result().state==='passed') || result.testModules.some(m=>!same(m.moduleId) || m.state()!=='passed') || tests.some(t=>t.result().state==='failed' || t.result().state==='pending')) process.exitCode=1;
} catch { console.error('限定Vitestテストに失敗しました。対象・設定・依存を確認してください。'); process.exitCode=1; }
finally { await ctx?.close(); await rm(cache,{recursive:true,force:true}); }
`;

export async function projectVitest(
  inventory: ProjectInventory,
  testFile: string,
  program: string,
  signal: AbortSignal,
  dependencySource?: string,
) {
  const known = new Map(inventory.files.map((f) => [f.path, f])),
    cwd = inventory.cwd;
  async function text(path: string) {
    const file = known.get(path);
    if (!file) throw new WorkflowFailure("test-input-not-inspected");
    const data = await readFile(await scopedPath(cwd, path));
    if (sha(data) !== file.hash)
      throw new WorkflowFailure("test-input-changed");
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  }
  let manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = {};
  if (known.has("package.json")) {
    try {
      manifest = JSON.parse(await text("package.json"));
    } catch {
      throw new WorkflowFailure("invalid-test-package-manifest");
    }
  }
  const testSource = await text(testFile),
    typescript = /\.(tsx?|mts|cts|jsx)$/.test(testFile);
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  if (!typescript && (!declared.vitest || /["']node:test["']/.test(testSource)))
    return;
  if (!declared.vitest)
    throw new WorkflowFailure("declared-installed-vitest-required");
  const configs = inventory.files.filter((f) =>
    /^(vitest|vite)\.config\.(ts|mts|cts|js|mjs|cjs)$/.test(f.path),
  );
  const preferred = configs.filter((f) => f.path.startsWith("vitest."));
  const choices = preferred.length ? preferred : configs;
  if (choices.length > 1)
    throw new WorkflowFailure("ambiguous-vitest-configuration");
  const config = choices[0]?.path ?? null;
  const roots = new Set(["vitest"]),
    visited = new Set<string>(),
    settings = new Set<string>();
  for (const f of inventory.files)
    if (
      /^(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|tsconfig[^/]*\.json)$/.test(
        f.path,
      )
    )
      settings.add(f.path);
  async function visit(path: string, setting = false) {
    signal.throwIfAborted();
    if (setting) settings.add(path);
    if (visited.has(path)) return;
    visited.add(path);
    const source = await text(path),
      ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const imports: string[] = [],
      literals: string[] = [];
    function scan(node: ts.Node) {
      if (
        ts.isPropertyAssignment(node) &&
        (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
        node.name.text === "environment" &&
        ts.isStringLiteral(node.initializer)
      ) {
        const name =
          node.initializer.text === "jsdom"
            ? "jsdom"
            : node.initializer.text === "happy-dom"
              ? "happy-dom"
              : null;
        if (name) {
          if (!declared[name])
            throw new WorkflowFailure("undeclared-test-dependency");
          roots.add(name);
        }
      }
      if (ts.isStringLiteral(node)) literals.push(node.text);
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require")) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, scan);
    }
    scan(ast);
    // Setup paths are data in the config, not imports. Bind them without running it.
    if (setting)
      for (const literal of literals.filter((p) =>
        /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(p),
      )) {
        const candidate = literal.replace(/^\.\//, "");
        if (known.has(candidate)) await visit(candidate, true);
      }
    for (const specifier of imports) {
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        const base = relative(
          cwd,
          resolve(cwd, dirname(path), specifier),
        ).replaceAll("\\", "/");
        const candidates = [
          base,
          ...[".ts", ".tsx", ".mts", ".cts"].map((ext) =>
            base.replace(/\.(js|mjs|cjs)$/, ext),
          ),
          ...[".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"].map(
            (ext) => base + ext,
          ),
        ];
        const found = candidates.find((p) => known.has(p));
        if (!found)
          throw new WorkflowFailure("local-test-import-not-inspected");
        await visit(found, setting);
      } else {
        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0]!;
        if (!declared[name])
          throw new WorkflowFailure("undeclared-test-dependency");
        roots.add(name);
      }
    }
  }
  await visit(testFile);
  if (config) await visit(config, true);
  const dependencies = await testDependencies(
    dependencySource ?? cwd,
    [...roots],
    signal,
  );
  const version = dependencies.snapshot.packages.find(
    (p) => p.name === "vitest",
  )!.version;
  if (!/^5\./.test(version)) throw new WorkflowFailure("vitest-5-required");
  const command = `node node_modules/.xharness-vitest-runner.mjs ${testFile}${config ? ` ${config}` : ""}`;
  const setup: VitestSetup = {
    kind: "vitest",
    version,
    config,
    settings: [...settings]
      .sort()
      .map((path) => ({ path, hash: known.get(path)!.hash })),
    dependencies: dependencies.snapshot,
    command,
  };
  const test: TestSpec = {
    id: "project-vitest-test",
    program,
    args: [
      "node_modules/.xharness-vitest-runner.mjs",
      testFile,
      ...(config ? [config] : []),
    ],
    command,
    timeoutMs: 120000,
  };
  async function checkSettings(destination = cwd) {
    for (const f of setup.settings)
      if (sha(await readFile(await scopedPath(destination, f.path))) !== f.hash)
        throw new WorkflowFailure("test-settings-changed");
    const original = known.get(testFile)!;
    if (
      sha(await readFile(await scopedPath(destination, testFile))) !==
      original.hash
    )
      throw new WorkflowFailure("immutable-test-changed");
  }
  return {
    setup,
    test,
    async check() {
      await checkSettings();
      await dependencies.checkSource();
    },
    async prepare(destination: string, operationSignal: AbortSignal) {
      if (destination === cwd)
        throw new WorkflowFailure("vitest-isolated-workspace-required");
      await checkSettings(destination);
      const guard = await dependencies.materialize(
        destination,
        operationSignal,
        ["node_modules/.xharness-vitest-runner.mjs"],
      );
      const runner = join(
        destination,
        "node_modules/.xharness-vitest-runner.mjs",
      );
      await writeFile(runner, VITEST_RUNNER, { flag: "wx" });
      return async () => {
        await checkSettings(destination);
        if (
          sha(
            await readFile(
              await scopedPath(
                destination,
                "node_modules/.xharness-vitest-runner.mjs",
              ),
            ),
          ) !== sha(VITEST_RUNNER)
        )
          throw new WorkflowFailure("test-runner-changed");
        await guard();
      };
    },
  };
}
