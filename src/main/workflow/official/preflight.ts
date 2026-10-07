import { execFile } from "node:child_process";
import { lstat, realpath, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  workflowGitEnvironment,
  workflowGitPolicyArgs,
  unsafeWorkflowGitConfig,
  scopedPath,
} from "./workspace.js";
import { relativeFile, normalizeFile } from "./contracts.js";

/** Read-only inspection, not a sandbox or permission to dispatch a native task. */
export async function projectPreflight(
  cwd: string,
  files: string[],
  signal: AbortSignal,
  /** Only a worktree already associated with this source by the session controller. */
  worktreeSource?: string,
) {
  const root = resolve(cwd),
    blockers = new Set<string>();
  const exists = async (path: string) => {
    try {
      return await lstat(path);
    } catch (error) {
      if (
        ["ENOENT", "ENOTDIR"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        return undefined;
      throw error;
    }
  };
  if (normalizeFile(await realpath(root)) !== normalizeFile(root))
    blockers.add("linked-project-root");
  const gitDirectory = await exists(join(root, ".git"));
  let configDirectory = join(root, ".git");
  if (!gitDirectory?.isDirectory() || gitDirectory.isSymbolicLink()) {
    try {
      if (
        !worktreeSource ||
        !gitDirectory?.isFile() ||
        gitDirectory.isSymbolicLink() ||
        gitDirectory.nlink !== 1 ||
        gitDirectory.size > 4096
      )
        throw new Error();
      const origin = resolve(worktreeSource),
        common = join(origin, ".git");
      if (
        normalizeFile(await realpath(origin)) !== normalizeFile(origin) ||
        !(await lstat(common)).isDirectory() ||
        normalizeFile(await realpath(common)) !== normalizeFile(common)
      )
        throw new Error();
      const pointer = /^gitdir: (.+)\r?\n?$/.exec(
        await readFile(join(root, ".git"), "utf8"),
      );
      const metadata = pointer ? resolve(root, pointer[1]!) : "";
      const expectedParent = join(common, "worktrees");
      if (
        !metadata ||
        normalizeFile(await realpath(metadata)) !== normalizeFile(metadata) ||
        normalizeFile(resolve(metadata, "..")) !== normalizeFile(expectedParent)
      )
        throw new Error();
      for (const name of ["commondir", "gitdir"]) {
        const stat = await lstat(join(metadata, name));
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 4096
        )
          throw new Error();
      }
      if (
        normalizeFile(
          await realpath(
            resolve(
              metadata,
              (await readFile(join(metadata, "commondir"), "utf8")).trim(),
            ),
          ),
        ) !== normalizeFile(common) ||
        normalizeFile(
          resolve((await readFile(join(metadata, "gitdir"), "utf8")).trim()),
        ) !== normalizeFile(join(root, ".git"))
      )
        throw new Error();
      if (await exists(join(metadata, "config.worktree"))) throw new Error();
      configDirectory = common;
    } catch {
      blockers.add("shared-or-linked-git-directory");
    }
  }
  const gitConfig = await exists(join(configDirectory, "config"));
  if (
    !gitConfig?.isFile() ||
    gitConfig.isSymbolicLink() ||
    gitConfig.nlink !== 1 ||
    normalizeFile(await realpath(join(configDirectory, "config"))) !==
      normalizeFile(join(configDirectory, "config"))
  )
    blockers.add("unsafe-git-configuration");
  if (
    blockers.has("shared-or-linked-git-directory") ||
    blockers.has("unsafe-git-configuration")
  )
    return {
      version: 1,
      cwd: root,
      head: null,
      clean: null,
      files,
      blockers: [...blockers].sort(),
      inspectionPassed: false,
      nativeDagEnabled: false,
      filesystemIsolationVerified: false,
      note: "Git metadata was rejected; no provider, test or mutation was started.",
    };
  if (!files.length || files.length > 30) blockers.add("invalid-file-count");
  if (new Set(files.map(normalizeFile)).size !== files.length)
    blockers.add("duplicate-files");
  for (const file of files) {
    if (!relativeFile.safeParse(file).success) {
      blockers.add("unsafe-planned-path");
      continue;
    }
    try {
      const stat = await exists(await scopedPath(root, file));
      if (stat && (!stat.isFile() || stat.nlink !== 1))
        blockers.add("linked-or-nonfile-planned-path");
    } catch {
      blockers.add("unsafe-planned-path");
    }
  }
  // Inspect metadata only; never read settings, credentials, or execute project hooks.
  for (const path of [
    ".claude",
    ".codex",
    ".mcp.json",
    ".gitattributes",
    ".gitmodules",
  ])
    if (await exists(join(root, path)))
      blockers.add(`project-configuration:${path}`);
  const git = (args: string[]) =>
    new Promise<string>((done, fail) =>
      execFile(
        "git",
        [...workflowGitPolicyArgs(), "-c", `safe.directory=${root}`, ...args],
        {
          cwd: root,
          signal,
          windowsHide: true,
          maxBuffer: 950000,
          encoding: "utf8",
          env: {
            ...workflowGitEnvironment(),
            GIT_OPTIONAL_LOCKS: "0",
          },
        },
        (error, stdout) => {
          if (error && !(args[0] === "config" && error.code === 1))
            fail(new Error("preflight-git-unavailable-or-limit"));
          else done(stdout);
        },
      ),
    );
  if (
    (
      await git([
        "config",
        "--no-includes",
        "--local",
        "--name-only",
        "--get-regexp",
        unsafeWorkflowGitConfig,
      ])
    ).trim()
  )
    blockers.add("local-git-execution-configuration");
  // Even rev-parse follows include paths; inspect names with --no-includes first.
  const unsafeGit = blockers.has("local-git-execution-configuration");
  const head = unsafeGit ? null : (await git(["rev-parse", "HEAD"])).trim();
  if (head !== null && !/^[a-f0-9]{40,64}$/.test(head))
    throw new Error("invalid-git-head");
  if (
    !unsafeGit &&
    /(^|\0)(120000|160000) /.test(await git(["ls-files", "--stage", "-z"]))
  )
    blockers.add("tracked-link-or-submodule");
  if (
    !unsafeGit &&
    (await git(["ls-files", "-z"]))
      .split("\0")
      .some((file) => /(^|[\\/])\.gitattributes$/i.test(file))
  )
    blockers.add("project-configuration:.gitattributes");
  if (
    !unsafeGit &&
    normalizeFile((await git(["rev-parse", "--show-toplevel"])).trim()) !==
      normalizeFile(root)
  )
    blockers.add("project-must-be-repository-root");
  // status can execute clean filters: skip it when configuration is uncertain.
  const clean =
    blockers.has("local-git-execution-configuration") ||
    blockers.has("project-configuration:.gitattributes")
      ? null
      : !(await git(["status", "--porcelain=v1", "--untracked-files=all"]))
          .length;
  if (clean === false) blockers.add("uncommitted-changes-preserved");
  if (clean === null) blockers.add("cleanliness-unmeasured");
  return {
    version: 1,
    cwd: root,
    head,
    clean,
    files,
    blockers: [...blockers].sort(),
    inspectionPassed: blockers.size === 0,
    nativeDagEnabled: false,
    filesystemIsolationVerified: false,
    note: "Inspection never starts providers, tests, worktrees or commits. Native DAG remains disabled; approved shell/test code can write outside per-file tool permissions.",
  };
}
