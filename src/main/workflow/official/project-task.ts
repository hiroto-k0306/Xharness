import { lstat, realpath } from "node:fs/promises";
import { join, delimiter, isAbsolute, relative } from "node:path";
import {
  relativeFile,
  normalizeFile,
  WorkflowFailure,
  type TestSpec,
} from "./contracts.js";
import { projectPreflight } from "./preflight.js";
import { scopedPath } from "./workspace.js";
import type { OfficialTaskScope } from "../../../shared/official-session.js";
import { inspectProjectInventory } from "./project-inventory.js";
import { projectVitest } from "./project-vitest.js";

export const projectTest = (
  testFile: string,
  program = process.execPath,
): TestSpec => ({
  id: "project-node-test",
  program,
  args: ["--test", testFile],
  command: `node --test ${testFile}`,
  timeoutMs: 60000,
});
/** Resolve host Node without executing anything or searching the project's current directory. */
export async function projectNode(cwd: string, path: string, source?: string) {
  const inside = (root: string, target: string) => {
    const rel = relative(root, target);
    return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  for (const directory of path.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    try {
      const candidate = join(
          directory,
          process.platform === "win32" ? "node.exe" : "node",
        ),
        stat = await lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const actual = await realpath(candidate);
      if (inside(cwd, actual) || (source && inside(source, actual))) continue;
      return actual;
    } catch {
      /* Inaccessible/missing candidates do not authorize a project executable. */
    }
  }
  throw new WorkflowFailure("trusted-host-node-executable-unavailable");
}
export function validateProjectScope(scope: OfficialTaskScope) {
  if (
    !scope.files.length ||
    scope.files.length > 29 ||
    new Set(scope.files.map(normalizeFile)).size !== scope.files.length
  )
    throw new WorkflowFailure("invalid-project-scope");
  [...scope.files, scope.testFile].forEach((f) => relativeFile.parse(f));
  if (
    [...scope.files, scope.testFile].some((file) =>
      /(^|[\\/])(\.claude|\.codex|\.xharness|\.mcp\.json|\.gitattributes|\.gitmodules)($|[\\/])/i.test(
        file,
      ),
    )
  )
    throw new WorkflowFailure("project-configuration-is-not-task-scope");
  if (
    scope.testFile.startsWith("-") ||
    !/^[A-Za-z0-9_./-]+\.(mjs|cjs|js|ts|tsx|mts|cts|jsx)$/.test(
      scope.testFile,
    ) ||
    (/\.(ts|tsx|mts|cts|jsx)$/.test(scope.testFile) &&
      !/[.-](test|spec)\.(ts|tsx|mts|cts|jsx)$/.test(scope.testFile)) ||
    scope.files.some((f) => normalizeFile(f) === normalizeFile(scope.testFile))
  )
    throw new WorkflowFailure("immutable-node-test-required");
}
/** Read-only preflight of the existing session directory. No copy, checkout, installation or test execution. */
export async function prepareProjectTask(
  cwd: string,
  scope: OfficialTaskScope,
  signal: AbortSignal,
  worktreeSource?: string,
) {
  validateProjectScope(scope);
  for (const name of [".xharness", ".claude", ".codex", ".mcp.json"]) {
    try {
      await lstat(join(cwd, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new WorkflowFailure("project-native-or-harness-configuration");
  }
  const inspection = await projectPreflight(
    cwd,
    [...scope.files, scope.testFile],
    signal,
    worktreeSource,
  );
  if (!inspection.inspectionPassed || !inspection.head)
    throw new Error(
      `作業の準備を停止しました：${inspection.blockers.join(", ")}。既存の変更を保全し、計画・実装を開始していません。`,
    );
  const test = await lstat(await scopedPath(cwd, scope.testFile));
  if (!test.isFile() || test.nlink !== 1)
    throw new WorkflowFailure("existing-independent-test-required");
  const program = process.versions.electron
    ? await projectNode(cwd, process.env.PATH ?? "", worktreeSource)
    : process.execPath;
  const vitest = await projectVitest(
    await inspectProjectInventory(cwd, signal),
    scope.testFile,
    program,
    signal,
    worktreeSource,
  );
  return {
    cwd: inspection.cwd,
    source: inspection.cwd,
    sourceHead: inspection.head,
    files: [...scope.files],
    testFile: scope.testFile,
    test: vitest?.test ?? projectTest(scope.testFile, program),
    vitest,
  };
}
