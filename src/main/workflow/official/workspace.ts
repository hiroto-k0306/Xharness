import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { spawnOwnedProcess } from "./owned-process.js";
import { lstat, realpath, readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, dirname } from "node:path";
import { assertSafeGitAttributes } from "./git-attributes.js";
import {
  relativeFile,
  normalizeFile,
  WorkflowFailure,
  type WorkspacePort,
  type TestSpec,
  type TestEvidence,
} from "./contracts.js";

/** Do not pass API credentials, arbitrary Node options, or shell/profile injection to helpers. */
export function runtimeEnvironment(source = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
  ])
    if (source[key] !== undefined) env[key] = source[key];
  return env;
}
/** Identical configuration boundary for preflight and every workflow Git command. */
export function workflowGitEnvironment(
  source = process.env,
): NodeJS.ProcessEnv {
  return {
    ...runtimeEnvironment(source),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
  };
}
export const workflowGitPolicyArgs = () => [
  "--no-pager",
  "--no-replace-objects",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/xharness-disabled-hooks",
  "-c",
  "commit.gpgsign=false",
  "-c",
  `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
];
export const unsafeWorkflowGitConfig =
  "^(filter\\.|core\\.(hookspath|fsmonitor|attributesfile)|include\\.|includeif\\.|extensions\\.worktreeconfig)";
export async function scopedPath(cwd: string, path: string) {
  const root = await realpath(cwd),
    target = resolve(cwd, path),
    rel = relative(root, target);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel.startsWith("..") ||
    !relativeFile.safeParse(rel).success
  )
    throw new WorkflowFailure("unsafe-path");
  let check = target;
  while (check !== root) {
    try {
      if ((await lstat(check)).isSymbolicLink())
        throw new WorkflowFailure("linked-path");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const parent = dirname(check);
    if (parent === check) throw new WorkflowFailure("unsafe-path");
    check = parent;
  }
  return target;
}
export function gitWorkspace(
  cwd: string,
  redact: (s: string) => string,
  dependencyIntegrity?: () => Promise<void>,
): WorkspacePort {
  const execute = (
    args: string[],
    signal: AbortSignal,
    configuration = false,
  ) =>
    new Promise<string>((done, fail) => {
      execFile(
        "git",
        [...workflowGitPolicyArgs(), "-c", `safe.directory=${cwd}`, ...args],
        {
          cwd,
          signal,
          windowsHide: true,
          maxBuffer: 950000,
          encoding: "utf8",
          env: workflowGitEnvironment(),
        },
        (error, stdout) =>
          error && !(configuration && error.code === 1)
            ? fail(new WorkflowFailure("git-unavailable-or-limit"))
            : done(stdout),
      );
    });
  const git = async (args: string[], signal: AbortSignal) => {
    // Recheck before each read/write; a native task must not introduce an
    // include/filter after preflight and activate it in the next Git command.
    const unsafe = await execute(
      [
        "config",
        "--no-includes",
        "--local",
        "--name-only",
        "--get-regexp",
        unsafeWorkflowGitConfig,
      ],
      signal,
      true,
    );
    if (unsafe.trim())
      throw new WorkflowFailure("local-git-execution-configuration");
    if (["status", "add", "diff", "check-attr"].includes(args[0]!)) {
      const [tracked, common] = await Promise.all([
        execute(["ls-files", "-z"], signal),
        execute(["rev-parse", "--git-common-dir"], signal),
      ]);
      await assertSafeGitAttributes(
        cwd,
        tracked.split("\0"),
        common.trim(),
        signal,
      );
    }
    return execute(args, signal);
  };
  const changes = async (signal: AbortSignal) => {
    const tokens = (
      await git(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          ...(dependencyIntegrity ? ["--", ".", ":(exclude)node_modules"] : []),
        ],
        signal,
      )
    ).split("\0");
    const files: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const line = tokens[i]!;
      if (!line) continue;
      files.push(line.slice(3));
      if (/R|C/.test(line.slice(0, 2))) files.push(tokens[++i]!);
    }
    return [...new Set(files)];
  };
  const hash = async (signal: AbortSignal) => {
    const head = (await git(["rev-parse", "HEAD"], signal)).trim();
    if (!/^[a-f0-9]{40,64}$/.test(head))
      throw new WorkflowFailure("invalid-git-head");
    return head;
  };
  return {
    async inspect(signal) {
      await dependencyIntegrity?.();
      if (normalizeFile(await realpath(cwd)) !== normalizeFile(resolve(cwd)))
        throw new WorkflowFailure("linked-workspace");
      const root = (await git(["rev-parse", "--show-toplevel"], signal)).trim();
      if (normalizeFile(root) !== normalizeFile(resolve(cwd)))
        throw new WorkflowFailure("workspace-must-be-repository-root");
      return {
        head: await hash(signal),
        clean: !(await changes(signal)).length,
      };
    },
    async commit(allowed, signal, as) {
      await dependencyIntegrity?.();
      const files = await changes(signal);
      if (
        !files.length ||
        files.some(
          (f) => !allowed.some((a) => normalizeFile(f) === normalizeFile(a)),
        )
      )
        throw new WorkflowFailure("scope-violation");
      for (const f of files) {
        const path = await scopedPath(cwd, f);
        try {
          const stat = await lstat(path);
          if (!stat.isFile() || stat.nlink > 1 || stat.size > 900000)
            throw new WorkflowFailure("unsafe-change");
          const bytes = await readFile(path),
            text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (
            text.includes("\0") ||
            redact(text) !== text ||
            /sk-(?:ant-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(
              text,
            )
          )
            throw new WorkflowFailure("secret-or-binary-change");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
      }
      const attributes = await git(
        ["check-attr", "filter", "--", ...files],
        signal,
      );
      if (
        attributes
          .split("\n")
          .some(
            (l) => l.trim() && !/filter: (unspecified|unset)$/.test(l.trim()),
          )
      )
        throw new WorkflowFailure("git-filter-not-supported");
      await git(["add", "--", ...files], signal);
      await git(
        [
          "-c",
          `user.name=${as?.name ?? "XHarness"}`,
          "-c",
          `user.email=${as?.email ?? "xharness@local"}`,
          "commit",
          "-m",
          as?.message ?? "workflow: approved single-task change",
        ],
        signal,
      );
      return hash(signal);
    },
    async identity(rev, files, signal) {
      if (!/^[a-f0-9]{40,64}$/.test(rev))
        throw new WorkflowFailure("invalid-git-head");
      const root = await realpath(
        (await git(["rev-parse", "--show-toplevel"], signal)).trim(),
      );
      const gitDir = await realpath(
        (await git(["rev-parse", "--absolute-git-dir"], signal)).trim(),
      );
      const digests: Record<string, string> = {};
      for (const f of files) {
        relativeFile.parse(f);
        digests[f] = createHash("sha256")
          .update(await git(["show", `${rev}:${f}`], signal))
          .digest("hex");
      }
      return { root, gitDir, digests };
    },
    async snapshot(base, head, signal) {
      await dependencyIntegrity?.();
      if (
        ![base, head].every((h) => /^[a-f0-9]{40,64}$/.test(h)) ||
        (await hash(signal)) !== head ||
        (await changes(signal)).length
      )
        throw new WorkflowFailure("snapshot-changed");
      const files = (
        await git(["diff", "--name-only", "-z", base, head, "--"], signal)
      )
        .split("\0")
        .filter(Boolean);
      files.forEach((f) => relativeFile.parse(f));
      const numstat = await git(
        [
          "diff",
          "--numstat",
          "--no-ext-diff",
          "--no-textconv",
          base,
          head,
          "--",
        ],
        signal,
      );
      if (/^-/m.test(numstat))
        throw new WorkflowFailure("binary-review-not-supported");
      const diff = await git(
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--full-index",
          base,
          head,
          "--",
        ],
        signal,
      );
      if (diff.length > 900000 || redact(diff) !== diff)
        throw new WorkflowFailure("unsafe-review-diff");
      return { base, head, files, diff };
    },
    test: async (spec, signal) => {
      await dependencyIntegrity?.();
      const result = await runAcceptance(cwd, spec, signal, redact);
      await dependencyIntegrity?.();
      return result;
    },
  };
}
export function runAcceptance(
  cwd: string,
  spec: TestSpec,
  signal: AbortSignal,
  redact: (s: string) => string,
): Promise<TestEvidence> {
  return new Promise((done) => {
    const started = Date.now(),
      controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(spec.timeoutMs, 600000),
    );
    const inner = AbortSignal.any([signal, controller.signal]);
    let output = "",
      finished = false;
    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({
        id: spec.id,
        exitCode,
        passed: exitCode === 0 && !inner.aborted,
        elapsedMs: Date.now() - started,
        output: redact(output),
        source: "process",
      });
    };
    try {
      const child = spawnOwnedProcess(spec.program, spec.args, {
        cwd,
        signal: inner,
        shell: false,
        windowsHide: true,
        env: runtimeEnvironment(),
      });
      const append = (bytes: Buffer) => {
        if (output.length < 30000)
          output += bytes.toString().slice(0, 30000 - output.length);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      // Await close after an AbortError as well: reporting cancellation must not
      // release the workflow while the owned supervisor still holds its Job.
      child.once("error", () => {});
      child.once("close", finish);
    } catch {
      finish(null);
    }
  });
}
