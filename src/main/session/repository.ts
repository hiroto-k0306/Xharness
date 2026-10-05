import { spawn } from "node:child_process";
import { mkdir, stat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  resolve,
  relative,
  isAbsolute,
} from "node:path";
export interface Worktree {
  path: string;
  branch: string;
  baseBranch: string;
}
export type GitRunner = (
  args: string[],
  cwd: string | undefined,
  signal: AbortSignal,
  progress?: (message: string) => void,
) => Promise<string>;
export const runGit: GitRunner = (args, cwd, signal, progress) =>
  new Promise((resolveOutput, reject) => {
    // Internal status checks run without user confirmation. Disable the helper
    // that Git otherwise loads from the repository's core.fsmonitor setting.
    const safeArgs = ["--no-pager", "-c", "core.fsmonitor=false", ...args];
    const child = spawn("git", safeArgs, {
      cwd,
      signal,
      windowsHide: true,
      shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    child.stdout.on("data", (data: Buffer) => {
      if (stdout.length < 1_000_000) stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      const match =
        /(Receiving objects|Resolving deltas|Counting objects|Compressing objects):\s*(\d{1,3})%/.exec(
          data.toString(),
        );
      if (match) progress?.(`${match[1]}: ${match[2]}%`);
    });
    child.on("error", () =>
      reject(new Error("Git operation unavailable or aborted")),
    );
    child.on("close", (code) =>
      code === 0
        ? resolveOutput(stdout.trim())
        : reject(new Error("Git operation failed")),
    );
  });
export function repositoryUrl(raw: string): string {
  if (!raw || raw.length > 2000 || /[\s\x00-\x1f]/.test(raw))
    throw new Error("Invalid repository URL");
  if (/^[\w.-]+@[\w.-]+:[\w./-]+$/.test(raw)) return raw;
  const url = new URL(raw);
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    (url.username && url.protocol !== "ssh:")
  )
    throw new Error("Invalid repository URL");
  return url.href.replace(/\/$/, "");
}
function branchName(raw: string) {
  if (!raw || raw.startsWith("-") || /[\s~^:?*[\\]|\.\.|@\{|\x00/.test(raw))
    throw new Error("Invalid branch");
  return raw;
}
export class Repository {
  constructor(
    private readonly home: string,
    private readonly git: GitRunner = runGit,
  ) {}
  async available() {
    try {
      await this.git(["--version"], undefined, new AbortController().signal);
      return true;
    } catch {
      return false;
    }
  }
  async open(
    options: {
      url: string;
      destination?: string;
      branch?: string;
      shallow?: boolean;
    },
    signal: AbortSignal,
    progress?: (message: string) => void,
  ) {
    const url = repositoryUrl(options.url);
    const name = basename(url.replace(/\.git$/, ""));
    const parts = (
      url.includes("://")
        ? new URL(url).pathname
        : url.slice(url.indexOf(":") + 1)
    )
      .split("/")
      .filter(Boolean);
    const owner = parts.at(-2) ?? "repository";
    if (
      ![owner, name].every(
        (s) => /^[\w.-]+$/.test(s) && s !== "." && s !== "..",
      )
    )
      throw new Error("Invalid repository path");
    const destination = resolve(
      options.destination ?? join(this.home, "repos", owner, name),
    );
    let exists = false;
    try {
      exists = (await stat(destination)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      const remote = await this.git(
        ["config", "--get", "remote.origin.url"],
        destination,
        signal,
      );
      if (repositoryUrl(remote) !== url)
        throw new Error("Existing directory belongs to another repository");
      progress?.("fetch");
      await this.git(
        ["fetch", "--progress", "origin"],
        destination,
        signal,
        progress,
      );
      if (options.branch) {
        if (await this.git(["status", "--porcelain"], destination, signal))
          throw new Error("Existing repository has uncommitted changes");
        await this.git(
          ["checkout", branchName(options.branch)],
          destination,
          signal,
        );
      }
    } else {
      await mkdir(dirname(destination), { recursive: true });
      progress?.("clone");
      await this.git(
        [
          "clone",
          "--progress",
          ...(options.shallow ? ["--depth", "1"] : []),
          ...(options.branch ? ["--branch", branchName(options.branch)] : []),
          "--",
          url,
          destination,
        ],
        undefined,
        signal,
        progress,
      );
    }
    return { root: destination, remoteUrl: url };
  }
  async createWorktree(
    root: string,
    workspaceId: string,
    sessionId: string,
    signal: AbortSignal,
    base?: string,
    newBranch?: string,
  ): Promise<Worktree> {
    if (!/^[\w-]+$/.test(workspaceId) || !/^[\w-]+$/.test(sessionId))
      throw new Error("Invalid worktree identity");
    const path = join(this.home, "worktrees", workspaceId, sessionId);
    const baseBranch = base
      ? branchName(base)
      : await this.git(["rev-parse", "--abbrev-ref", "HEAD"], root, signal);
    const branch = branchName(newBranch ?? `xh/${sessionId}`);
    await mkdir(dirname(path), { recursive: true });
    await this.git(
      ["worktree", "add", "-b", branch, path, baseBranch],
      root,
      signal,
    );
    return { path, branch, baseBranch };
  }
  private managed(tree: Worktree) {
    const rel = relative(resolve(this.home, "worktrees"), resolve(tree.path));
    if (
      !rel ||
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      rel.split(/[\\/]/).length !== 2
    )
      throw new Error("Unmanaged worktree");
    branchName(tree.branch);
  }
  async restore(
    root: string,
    tree: Worktree,
    confirmed: boolean,
    signal: AbortSignal,
  ) {
    this.managed(tree);
    if (!confirmed) throw new Error("Worktree restore requires confirmation");
    try {
      await stat(tree.path);
      throw new Error("Worktree path already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await this.git(
      ["show-ref", "--verify", `refs/heads/${tree.branch}`],
      root,
      signal,
    );
    // --force twice permits reusing this missing, registered worktree path.
    await mkdir(dirname(tree.path), { recursive: true });
    await this.git(
      ["worktree", "add", "--force", "--force", tree.path, tree.branch],
      root,
      signal,
    );
  }
  async finish(
    root: string,
    tree: Worktree,
    action: "keep" | "merge" | "remove" | "remove_branch",
    confirmed: boolean,
    signal: AbortSignal,
  ) {
    this.managed(tree);
    if (action === "keep") return;
    if (action === "merge" && !confirmed)
      throw new Error("Worktree merge requires confirmation");
    const managedRoot = await realpath(join(this.home, "worktrees"));
    const actualPath = await realpath(tree.path);
    const actualRelative = relative(managedRoot, actualPath);
    if (
      !actualRelative ||
      actualRelative.startsWith("..") ||
      isAbsolute(actualRelative)
    )
      throw new Error("Unmanaged worktree target");
    const expectedGit = resolve(
      root,
      await this.git(["rev-parse", "--git-common-dir"], root, signal),
    );
    const actualGit = resolve(
      tree.path,
      await this.git(["rev-parse", "--git-common-dir"], tree.path, signal),
    );
    const normalize = (path: string) =>
      process.platform === "win32" ? path.toLowerCase() : path;
    if (
      normalize(await realpath(expectedGit)) !==
      normalize(await realpath(actualGit))
    )
      throw new Error("Worktree repository mismatch");
    if (
      (await this.git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        tree.path,
        signal,
      )) !== tree.branch
    )
      throw new Error("Worktree branch changed");
    const dirty = !!(await this.git(
      ["status", "--porcelain"],
      tree.path,
      signal,
    ));
    if (dirty && (action === "merge" || !confirmed))
      throw new Error("Worktree has uncommitted changes");
    if (action === "merge") {
      if (
        (await this.git(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          root,
          signal,
        )) !== tree.baseBranch
      )
        throw new Error(
          "Original repository branch changed; restore the base branch before merging",
        );
      if (await this.git(["status", "--porcelain"], root, signal))
        throw new Error("Original repository has uncommitted changes");
      try {
        await this.git(["merge", "--no-edit", tree.branch], root, signal);
      } catch (error) {
        // A conflicted merge leaves the original repository half-merged. The UI has
        // no way to resolve it, so restore the pre-merge state and say why.
        const merging = await this.git(
          ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
          root,
          signal,
        ).then(
          () => true,
          () => false,
        );
        if (!merging) throw error;
        await this.git(["merge", "--abort"], root, signal);
        throw new Error(
          "Worktree merge conflicts with the base branch; the merge was aborted and nothing changed",
        );
      }
      return;
    }
    if (!confirmed) throw new Error("Worktree removal requires confirmation");
    await this.git(
      ["worktree", "remove", ...(dirty ? ["--force"] : []), tree.path],
      root,
      signal,
    );
    if (action === "remove_branch")
      await this.git(["branch", "-D", tree.branch], root, signal);
  }
}
