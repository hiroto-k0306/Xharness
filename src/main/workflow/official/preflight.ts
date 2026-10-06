import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runtimeEnvironment, scopedPath } from "./workspace.js";
import { relativeFile, normalizeFile } from "./contracts.js";

/** Read-only inspection, not a sandbox or permission to dispatch a native task. */
export async function projectPreflight(
  cwd: string,
  files: string[],
  signal: AbortSignal,
) {
  const root = resolve(cwd),
    blockers = new Set<string>();
  const exists = async (path: string) => {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  if (normalizeFile(await realpath(root)) !== normalizeFile(root))
    blockers.add("linked-project-root");
  const gitDirectory = await exists(join(root, ".git"));
  if (!gitDirectory?.isDirectory() || gitDirectory.isSymbolicLink())
    blockers.add("shared-or-linked-git-directory");
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
        [
          "--no-pager",
          "-c",
          `safe.directory=${root}`,
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/xharness-disabled-hooks",
          ...args,
        ],
        {
          cwd: root,
          signal,
          windowsHide: true,
          maxBuffer: 950000,
          encoding: "utf8",
          env: {
            ...runtimeEnvironment(),
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL:
              process.platform === "win32" ? "NUL" : "/dev/null",
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
        "^(filter\\.|core\\.(hookspath|fsmonitor)|include\\.|includeif\\.)",
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
