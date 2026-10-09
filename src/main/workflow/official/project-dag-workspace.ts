import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { redact } from "../../core/redact.js";
import { isProtectedPath, isSecretPath } from "../../core/sensitive-paths.js";
import {
  relativeFile,
  normalizeFile,
  WorkflowFailure,
  type WorkspacePort,
} from "./contracts.js";
import {
  gitWorkspace,
  scopedPath,
  workflowGitEnvironment,
  workflowGitPolicyArgs,
} from "./workspace.js";

const exec = promisify(execFile);
const validHead = (head: string) => /^[a-f0-9]{40,64}$/.test(head);
function fail(code: string): never {
  throw new WorkflowFailure(code);
}
export interface ProjectDagWorkspaceOptions {
  cwd: string;
  ownedRoot: string;
  approvalDigest: string;
  baseHead?: string;
  signal: AbortSignal;
}
export interface ProjectDagTaskWorkspace {
  cwd: string;
  baseHead: string;
  files: string[];
  workspace: WorkspacePort;
  commit(options: {
    approvalDigest: string;
    signal: AbortSignal;
  }): Promise<string>;
}
interface TaskState {
  id: string;
  cwd: string;
  dependencies: string[];
  files: string[];
  baseHead?: string;
  commit?: string;
  status: "preparing" | "ready" | "committing" | "completed" | "uncertain";
}
const outside = (root: string, target: string) => {
  const rel = relative(root, target);
  return (
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\")
  );
};
async function safeDirectory(path: string) {
  let cursor = resolve(path);
  while (true) {
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink())
        fail("project-dag-linked-directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}
/** Clean Git project only; every checkout and commit is owned, never the user checkout. */
export async function createProjectDagWorkspace(
  options: ProjectDagWorkspaceOptions,
) {
  const source = resolve(options.cwd),
    ownedRoot = resolve(options.ownedRoot);
  const approvalDigest = options.approvalDigest;
  if (!/^[a-f0-9]{64}$/.test(approvalDigest))
    fail("project-dag-invalid-approval");
  if (!outside(source, ownedRoot)) fail("project-dag-owned-root-inside-source");
  await safeDirectory(source);
  await safeDirectory(ownedRoot);
  const sourcePort = gitWorkspace(source, redact);
  let initial;
  try {
    initial = await sourcePort.inspect(options.signal);
  } catch {
    return fail("project-dag-clean-git-required");
  }
  if (!initial.clean) fail("project-dag-clean-git-required");
  if (options.baseHead !== undefined && options.baseHead !== initial.head)
    fail("project-dag-source-base-changed");
  const sourceBase = initial.head;
  const execute = async (cwd: string, args: string[], signal: AbortSignal) => {
    signal.throwIfAborted();
    try {
      const result = await exec(
        "git",
        [
          ...workflowGitPolicyArgs(),
          "-c",
          `safe.directory=${cwd}`,
          "-c",
          "submodule.recurse=false",
          "-c",
          "protocol.allow=never",
          ...args,
        ],
        {
          cwd,
          signal,
          windowsHide: true,
          maxBuffer: 950000,
          env: workflowGitEnvironment(),
        },
      );
      return result.stdout.trim();
    } catch {
      return fail(
        signal.aborted ? "cancelled" : "project-dag-git-operation-failed",
      );
    }
  };
  const sourceBranch = await execute(
    source,
    ["branch", "--show-current"],
    options.signal,
  );
  const sourceCommon = await realpath(
    await execute(
      source,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      options.signal,
    ),
  );
  // Do not checkout gitlinks/submodules or linked tracked files into task scopes.
  const entries = await execute(
    source,
    ["ls-files", "--stage", "-z"],
    options.signal,
  );
  if (entries.split("\0").some((entry) => /^(?:160000|120000) /.test(entry)))
    fail("project-dag-linked-project-not-supported");
  await mkdir(ownedRoot, { recursive: true, mode: 0o700 });
  await safeDirectory(ownedRoot);
  if (normalizeFile(await realpath(ownedRoot)) !== normalizeFile(ownedRoot))
    fail("project-dag-linked-directory");
  const ownedDirectory = await mkdtemp(join(ownedRoot, "project-dag-"));
  const tasks = new Map<string, TaskState>();
  const registeredGitDirs = new Map<string, string>();
  let integration:
    | {
        cwd: string;
        head?: string;
        status: "preparing" | "completed" | "uncertain";
      }
    | undefined;
  let mutationQueue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(action);
    mutationQueue = result.catch(() => {});
    return result;
  };
  const snapshots = () => ({
    source,
    sourceBase,
    sourceBranch,
    approvalDigest,
    ownedDirectory,
    tasks: [...tasks.values()].map((task) => ({
      ...task,
      files: [...task.files],
      dependencies: [...task.dependencies],
    })),
    ...(integration ? { integration: { ...integration } } : {}),
  });
  const persist = () =>
    serialize(async () => {
      await safeDirectory(ownedDirectory);
      const temporary = join(ownedDirectory, `manifest-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify(snapshots(), null, 2), {
        flag: "wx",
        mode: 0o600,
      });
      // Replace a manifest entry atomically; never follow a substituted file symlink.
      await rename(temporary, join(ownedDirectory, "manifest.json"));
    });
  const approved = (digest: string) => {
    if (digest !== approvalDigest) fail("project-dag-approval-changed");
  };
  const sourceGuard = async (signal: AbortSignal) => {
    const current = await sourcePort.inspect(signal);
    if (
      !current.clean ||
      current.head !== sourceBase ||
      (await execute(source, ["branch", "--show-current"], signal)) !==
        sourceBranch
    )
      fail("project-dag-source-changed");
    if (
      normalizeFile(
        await realpath(
          await execute(
            source,
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            signal,
          ),
        ),
      ) !== normalizeFile(sourceCommon)
    )
      fail("project-dag-source-changed");
  };
  const ownedPort = async (cwd: string, signal: AbortSignal) => {
    if (dirname(cwd) !== ownedDirectory) fail("project-dag-unowned-worktree");
    await safeDirectory(cwd);
    const common = await execute(
      cwd,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      signal,
    );
    if (normalizeFile(await realpath(common)) !== normalizeFile(sourceCommon))
      fail("project-dag-foreign-worktree");
    const gitFile = join(cwd, ".git");
    const fileInfo = await lstat(gitFile);
    if (!fileInfo.isFile() || fileInfo.nlink !== 1)
      fail("project-dag-unowned-worktree-metadata");
    const gitDir = await execute(
      cwd,
      ["rev-parse", "--absolute-git-dir"],
      signal,
    );
    await safeDirectory(gitDir);
    if (
      normalizeFile(dirname(gitDir)) !==
        normalizeFile(join(sourceCommon, "worktrees")) ||
      normalizeFile((await readFile(join(gitDir, "gitdir"), "utf8")).trim()) !==
        normalizeFile(gitFile) ||
      (await execute(
        cwd,
        ["rev-parse", "--symbolic-full-name", "HEAD"],
        signal,
      )) !== "HEAD"
    )
      fail("project-dag-unowned-worktree-metadata");
    const pinned = registeredGitDirs.get(cwd);
    if (pinned && normalizeFile(pinned) !== normalizeFile(gitDir))
      fail("project-dag-unowned-worktree-metadata");
    registeredGitDirs.set(cwd, gitDir);
    const port = gitWorkspace(cwd, redact);
    await port.inspect(signal);
    return port;
  };
  const publicPort = (cwd: string): WorkspacePort => ({
    inspect: async (signal) => (await ownedPort(cwd, signal)).inspect(signal),
    snapshot: async (base, head, signal) =>
      (await ownedPort(cwd, signal)).snapshot(base, head, signal),
    test: async (spec, signal) =>
      (await ownedPort(cwd, signal)).test(spec, signal),
    commit: async () => fail("project-dag-wrapper-commit-required"),
  });
  const create = async (cwd: string, signal: AbortSignal) => {
    await sourceGuard(signal);
    await serialize(() =>
      execute(source, ["worktree", "add", "--detach", cwd, sourceBase], signal),
    );
    return ownedPort(cwd, signal);
  };
  const validateCommit = async (task: TaskState, signal: AbortSignal) => {
    if (!task.commit || !task.baseHead || !validHead(task.commit))
      fail("project-dag-dependency-not-completed");
    const port = await ownedPort(task.cwd, signal);
    const current = await port.inspect(signal);
    if (!current.clean || current.head !== task.commit)
      fail("project-dag-task-changed");
    const parent = await execute(
      task.cwd,
      ["rev-parse", `${task.commit}^`],
      signal,
    );
    if (parent !== task.baseHead) fail("project-dag-unowned-task-commit");
    const snapshot = await port.snapshot(task.baseHead, task.commit, signal);
    if (
      !snapshot.files.length ||
      snapshot.files.some((file) => !task.files.includes(file))
    )
      fail("project-dag-task-scope-violation");
  };
  const pick = async (cwd: string, ids: string[], signal: AbortSignal) => {
    for (const id of ids) {
      const task = tasks.get(id);
      if (!task || task.status !== "completed")
        fail("project-dag-dependency-not-completed");
      await validateCommit(task, signal);
      await ownedPort(cwd, signal);
      try {
        await execute(
          cwd,
          [
            "-c",
            "user.name=XHarness",
            "-c",
            "user.email=xharness@local",
            "cherry-pick",
            "--no-gpg-sign",
            task.commit!,
          ],
          signal,
        );
      } catch {
        return fail(
          signal.aborted ? "cancelled" : "project-dag-integration-conflict",
        );
      }
    }
  };
  await persist();
  return {
    sourceBase,
    ownedDirectory,
    snapshots,
    async task(
      id: string,
      dependencies: string[],
      files: string[],
      signal = options.signal,
    ): Promise<ProjectDagTaskWorkspace> {
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
        tasks.has(id) ||
        tasks.size >= 32 ||
        integration
      )
        fail("project-dag-invalid-task");
      if (
        !files.length ||
        files.length > 30 ||
        new Set(files).size !== files.length ||
        files.some(
          (file) =>
            !relativeFile.safeParse(file).success ||
            isProtectedPath(file) ||
            isSecretPath(file),
        )
      )
        fail("project-dag-invalid-task-scope");
      if (
        new Set(dependencies).size !== dependencies.length ||
        dependencies.includes(id)
      )
        fail("project-dag-invalid-dependencies");
      const ordered: string[] = [],
        seen = new Set<string>();
      const visit = (dependency: string) => {
        if (seen.has(dependency)) return;
        const task = tasks.get(dependency);
        if (!task || task.status !== "completed")
          fail("project-dag-dependency-not-completed");
        seen.add(dependency);
        task.dependencies.forEach(visit);
        ordered.push(dependency);
      };
      dependencies.forEach(visit);
      const state: TaskState = {
        id,
        cwd: join(ownedDirectory, `task-${id}`),
        dependencies: [...dependencies],
        files: [...files],
        status: "preparing",
      };
      tasks.set(id, state);
      await persist();
      try {
        const port = await create(state.cwd, signal);
        await pick(state.cwd, ordered, signal);
        const base = await port.inspect(signal);
        if (!base.clean) fail("project-dag-task-base-dirty");
        state.baseHead = base.head;
        state.status = "ready";
        await persist();
        return {
          cwd: state.cwd,
          baseHead: base.head,
          files: [...state.files],
          workspace: publicPort(state.cwd),
          async commit(commitOptions) {
            approved(commitOptions.approvalDigest);
            if (state.status !== "ready")
              fail("project-dag-task-in-flight-or-completed");
            await sourceGuard(commitOptions.signal);
            const owned = await ownedPort(state.cwd, commitOptions.signal);
            if (
              (await owned.inspect(commitOptions.signal)).head !==
              state.baseHead
            )
              fail("project-dag-unowned-task-commit");
            for (const file of state.files) await scopedPath(state.cwd, file);
            state.status = "committing";
            await persist();
            try {
              state.commit = await owned.commit(
                state.files,
                commitOptions.signal,
                {
                  name: "XHarness",
                  email: "xharness@local",
                  message: `workflow: approved DAG task ${id}`,
                },
              );
              await validateCommit(state, commitOptions.signal);
              await sourceGuard(commitOptions.signal);
              state.status = "completed";
              await persist();
              return state.commit;
            } catch (error) {
              state.status = "uncertain";
              await persist();
              throw error;
            }
          },
        };
      } catch (error) {
        state.status = "uncertain";
        await persist();
        throw error;
      }
    },
    async integrate(
      ids: string[],
      integrationOptions: { approvalDigest: string; signal: AbortSignal },
    ) {
      approved(integrationOptions.approvalDigest);
      if (
        integration ||
        !ids.length ||
        ids.length !== tasks.size ||
        new Set(ids).size !== ids.length
      )
        fail("project-dag-integration-in-flight-or-incomplete");
      const visited = new Set<string>();
      for (const id of ids) {
        const task = tasks.get(id);
        if (
          !task ||
          task.status !== "completed" ||
          task.dependencies.some((dep) => !visited.has(dep))
        )
          fail("project-dag-invalid-integration-order");
        visited.add(id);
      }
      integration = {
        cwd: join(ownedDirectory, "integration"),
        status: "preparing",
      };
      await persist();
      try {
        const port = await create(integration.cwd, integrationOptions.signal);
        await pick(integration.cwd, ids, integrationOptions.signal);
        await sourceGuard(integrationOptions.signal);
        const current = await port.inspect(integrationOptions.signal);
        if (!current.clean) fail("project-dag-integration-dirty");
        integration.head = current.head;
        integration.status = "completed";
        await persist();
        return {
          cwd: integration.cwd,
          baseHead: sourceBase,
          head: current.head,
          workspace: publicPort(integration.cwd),
        };
      } catch (error) {
        integration.status = "uncertain";
        await persist();
        throw error;
      }
    },
  };
}
export type ProjectDagWorkspace = Awaited<
  ReturnType<typeof createProjectDagWorkspace>
>;
