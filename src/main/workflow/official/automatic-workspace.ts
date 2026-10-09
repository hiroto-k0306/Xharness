import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, relative } from "node:path";
import { WorkflowFailure, type WorkspacePort } from "./contracts.js";
import type { OfficialTaskScope } from "../../../shared/official-session.js";
import {
  prepareProjectTask,
  projectNode,
  projectTest,
  validateProjectScope,
} from "./project-task.js";
import {
  assertInventoryUnchanged,
  type ProjectInventory,
} from "./project-inventory.js";
import {
  gitWorkspace,
  scopedPath,
  workflowGitEnvironment,
  workflowGitPolicyArgs,
} from "./workspace.js";
import { redact } from "../../core/redact.js";
import { projectVitest } from "./project-vitest.js";
import { projectPreflight } from "./preflight.js";

const exec = promisify(execFile);
export type WorkspacePreparation = {
  kind: "git-worktree" | "reuse-worktree" | "local-copy";
  destination: string;
  fingerprint: string;
};
/** Inspect first; every filesystem/Git mutation is deferred until the plan is approved. */
export async function automaticWorkspace(
  inventory: ProjectInventory,
  scope: OfficialTaskScope,
  id: string,
  signal: AbortSignal,
  worktreeSource?: string,
) {
  validateProjectScope(scope);
  if (
    scope.files.some((path) =>
      path
        .split(/[\\/]/)
        .some((part) =>
          ["node_modules", ".tools", ".out", ".xharness-workspaces"].includes(
            part.toLowerCase(),
          ),
        ),
    )
  )
    throw new WorkflowFailure("project-generated-directory-is-not-task-scope");
  if (!/^[a-f0-9-]{36}$/i.test(id) || !inventory.tests.includes(scope.testFile))
    throw new WorkflowFailure("existing-independent-test-required");
  const source = inventory.cwd;
  const git = (cwd: string, args: string[], operationSignal = signal) =>
    exec(
      "git",
      [...workflowGitPolicyArgs(), "-c", `safe.directory=${cwd}`, ...args],
      {
        cwd,
        signal: operationSignal,
        windowsHide: true,
        env: workflowGitEnvironment(),
      },
    );
  let isGit = false;
  try {
    await lstat(join(source, ".git"));
    isGit = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!isGit && worktreeSource)
    throw new WorkflowFailure("missing-session-worktree");
  // A subfolder of someone else's repository is not an unversioned project root.
  if (!isGit) {
    const parentRepo = await git(source, ["rev-parse", "--show-toplevel"]).then(
      (r) => r.stdout.trim(),
      () => undefined,
    );
    if (parentRepo)
      throw new WorkflowFailure("workspace-must-be-repository-root");
  }
  const snapshot = isGit
    ? await prepareProjectTask(source, scope, signal, worktreeSource)
    : undefined;
  const program =
    snapshot?.test.program ??
    (process.versions.electron
      ? await projectNode(source, process.env.PATH ?? "")
      : process.execPath);
  const vitest =
    snapshot?.vitest ??
    (await projectVitest(inventory, scope.testFile, program, signal));
  if (
    vitest &&
    scope.files.some((f) =>
      vitest.setup.settings.some(
        (s) => s.path.toLowerCase() === f.toLowerCase(),
      ),
    )
  )
    throw new WorkflowFailure("immutable-test-settings-required");
  const preparation: WorkspacePreparation = {
    kind:
      worktreeSource && !vitest
        ? "reuse-worktree"
        : isGit
          ? "git-worktree"
          : "local-copy",
    destination:
      worktreeSource && !vitest
        ? source
        : isGit
          ? join(dirname(source), "XHarness-workspaces", basename(source), id)
          : join(source, ".xharness-workspaces", id),
    fingerprint: inventory.fingerprint,
  };
  const head = snapshot?.sourceHead ?? inventory.fingerprint;
  const check = async (operationSignal = signal) => {
    await assertInventoryUnchanged(inventory, operationSignal);
    await vitest?.check();
    if (snapshot) {
      const current = await projectPreflight(
        source,
        [...scope.files, scope.testFile],
        operationSignal,
        worktreeSource,
      );
      if (current.head !== head)
        throw new WorkflowFailure("project-head-changed");
      if (!current.inspectionPassed)
        throw new WorkflowFailure("project-inspection-changed");
    }
  };
  const readonly: WorkspacePort = {
    inspect: async () => {
      await check();
      return { head, clean: true };
    },
    commit: async () => {
      throw new WorkflowFailure("workspace-not-approved");
    },
    snapshot: async () => {
      throw new WorkflowFailure("workspace-not-approved");
    },
    test: async () => {
      throw new WorkflowFailure("workspace-not-approved");
    },
  };
  let started = false;
  return {
    source,
    head,
    preparation,
    workspace: readonly,
    test: vitest?.test ?? projectTest(scope.testFile, program),
    testSetup: vitest?.setup,
    async prepare(runtimeSignal = signal) {
      const operationSignal = AbortSignal.any([signal, runtimeSignal]);
      if (started)
        throw new WorkflowFailure("workspace-preparation-already-started");
      started = true;
      operationSignal.throwIfAborted();
      await check(operationSignal);
      const cwd = preparation.destination;
      if (preparation.kind !== "reuse-worktree") {
        const parent = dirname(cwd);
        const boundary = isGit ? dirname(source) : source;
        await scopedPath(boundary, relative(boundary, parent));
        await mkdir(parent, { recursive: true });
        if ((await realpath(parent)) !== resolve(parent))
          throw new WorkflowFailure("linked-workspace-parent");
        try {
          await lstat(cwd);
          throw new WorkflowFailure("workspace-destination-exists");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        if (isGit)
          await git(
            source,
            ["worktree", "add", "-b", `xharness/auto-${id}`, cwd, head],
            operationSignal,
          );
        else {
          await mkdir(cwd);
          for (const file of inventory.files) {
            operationSignal.throwIfAborted();
            const from = await scopedPath(source, file.path),
              to = await scopedPath(cwd, file.path);
            await mkdir(dirname(to), { recursive: true });
            await copyFile(from, to);
          }
          await check(operationSignal);
          await assertInventoryUnchanged(
            { ...inventory, cwd },
            operationSignal,
          );
          // Initialization is confined to the approved child directory, never the original folder.
          await git(cwd, ["init"], operationSignal);
          await git(
            cwd,
            ["add", "--", ...inventory.files.map((f) => f.path)],
            operationSignal,
          );
          await git(
            cwd,
            [
              "-c",
              "user.name=XHarness",
              "-c",
              "user.email=xharness@local",
              "commit",
              "-m",
              "workspace: approved local snapshot",
            ],
            operationSignal,
          );
        }
      }
      await check(operationSignal);
      const integrity = await vitest?.prepare(cwd, operationSignal);
      const workspace = gitWorkspace(cwd, redact, integrity),
        initial = await workspace.inspect(operationSignal);
      if (!initial.clean || (isGit && initial.head !== head))
        throw new WorkflowFailure("prepared-workspace-mismatch");
      return { cwd, head: initial.head, workspace };
    },
  };
}
