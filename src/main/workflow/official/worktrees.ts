import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, lstat, realpath } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  gitWorkspace,
  workflowGitEnvironment,
  workflowGitPolicyArgs,
} from "./workspace.js";
import { WorkflowFailure, type WorkspacePort } from "./contracts.js";
const exec = promisify(execFile);
const hash = (s: string) => /^[a-f0-9]{40,64}$/.test(s);

/** Only a dedicated managed checkout; never merge into the user's checkout. */
export class OfficialWorktrees {
  readonly root: string;
  constructor(
    readonly cwd: string,
    readonly ownedDirectory: string,
    private redact: (s: string) => string,
  ) {
    this.root = join(ownedDirectory, "nodes");
  }
  private async boundary() {
    if (
      resolve(dirname(this.cwd)) !== resolve(this.ownedDirectory) ||
      (await realpath(this.cwd)).toLowerCase() !==
        resolve(this.cwd).toLowerCase() ||
      (await realpath(this.ownedDirectory)).toLowerCase() !==
        resolve(this.ownedDirectory).toLowerCase()
    )
      throw new WorkflowFailure("unowned-dag-workspace");
    if (!(await lstat(join(this.cwd, ".git"))).isDirectory())
      throw new WorkflowFailure("dag-root-must-own-git");
  }
  private async git(args: string[], signal: AbortSignal) {
    await this.boundary();
    // Apply the same local configuration guard before managed Git mutations.
    await gitWorkspace(this.cwd, this.redact).inspect(signal);
    const result = await exec(
      "git",
      [...workflowGitPolicyArgs(), "-c", `safe.directory=${this.cwd}`, ...args],
      {
        cwd: this.cwd,
        signal,
        windowsHide: true,
        maxBuffer: 950000,
        env: workflowGitEnvironment(),
      },
    );
    return result.stdout.trim();
  }
  async create(base: string, signal: AbortSignal) {
    if (!hash(base)) throw new WorkflowFailure("invalid-worktree-base");
    await this.boundary();
    await mkdir(this.root, { recursive: true });
    if (
      (await realpath(this.root)).toLowerCase() !==
      resolve(this.root).toLowerCase()
    )
      throw new WorkflowFailure("linked-worktrees");
    const path = join(this.root, randomUUID());
    await this.git(["worktree", "add", "--detach", path, base], signal);
    await this.open(path, signal);
    return path;
  }
  async history(base: string, head: string, signal: AbortSignal) {
    if (![base, head].every(hash))
      throw new WorkflowFailure("invalid-integration-head");
    const commits = (
      await this.git(["rev-list", "--reverse", `${base}..${head}`], signal)
    )
      .split("\n")
      .filter(Boolean);
    if (commits.length > 64 || commits.some((c) => !hash(c)))
      throw new WorkflowFailure("integration-history-limit");
    return commits;
  }
  async open(path: string, signal: AbortSignal): Promise<WorkspacePort> {
    await this.boundary();
    if (
      dirname(resolve(path)) !== resolve(this.root) ||
      !/^[a-f0-9-]{36}$/i.test(basename(path))
    )
      throw new WorkflowFailure("unowned-node-workspace");
    if ((await realpath(path)).toLowerCase() !== resolve(path).toLowerCase())
      throw new WorkflowFailure("linked-node-workspace");
    const common = (
      await exec(
        "git",
        [
          ...workflowGitPolicyArgs(),
          "-c",
          `safe.directory=${path}`,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        { cwd: path, signal, windowsHide: true, env: workflowGitEnvironment() },
      )
    ).stdout.trim();
    if (
      resolve(common).toLowerCase() !==
      join(resolve(this.cwd), ".git").toLowerCase()
    )
      throw new WorkflowFailure("foreign-node-workspace");
    return gitWorkspace(path, this.redact);
  }
  async integrate(
    path: string,
    base: string,
    head: string,
    expected: string,
    files: string[],
    signal: AbortSignal,
  ) {
    if (![base, head, expected].every(hash))
      throw new WorkflowFailure("invalid-integration-head");
    const node = await this.open(path, signal),
      root = gitWorkspace(this.cwd, this.redact);
    const current = await root.inspect(signal);
    if (!current.clean || current.head !== expected)
      throw new WorkflowFailure("integration-workspace-changed");
    const snapshot = await node.snapshot(base, head, signal);
    if (snapshot.files.some((f) => !files.includes(f)))
      throw new WorkflowFailure("integration-scope-violation");
    const commits = (
      await this.git(["rev-list", "--reverse", `${base}..${head}`], signal)
    )
      .split("\n")
      .filter(Boolean);
    if (!commits.length || commits.length > 3)
      throw new WorkflowFailure("integration-commit-limit");
    try {
      await this.git(
        [
          "-c",
          "user.name=XHarness",
          "-c",
          "user.email=xharness@local",
          "cherry-pick",
          "--no-gpg-sign",
          ...commits,
        ],
        signal,
      );
    } catch {
      // Cancellation may have unknown effects: preserve the intent and do not
      // claim rollback. A definite conflict can be aborted in this owned root.
      if (!signal.aborted) {
        try {
          await this.git(["cherry-pick", "--abort"], signal);
        } catch {
          /* Preserve uncertain state. */
        }
      }
      throw new WorkflowFailure(
        signal.aborted ? "cancelled" : "integration-conflict",
      );
    }
    return (await root.inspect(signal)).head;
  }
}
