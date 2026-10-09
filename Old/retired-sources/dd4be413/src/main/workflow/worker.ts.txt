import { join } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { type ToolRegistry, type Tool } from "../tools/registry.js";
import { type ChildRunner } from "../agents/runner.js";
import { Repository, runGit, type Worktree } from "../session/repository.js";
import { type PlanItem } from "./plan-validate.js";
import { Changes } from "./changes.js";
import { gitInfo } from "../session/store.js";

export interface WorkerReport {
  summary: string;
  changedFiles: string[];
  testsRun: string[];
}
export function report(input: unknown): WorkerReport | undefined {
  if (!input || typeof input !== "object") return;
  const value = input as WorkerReport;
  if (
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    !Array.isArray(value.changedFiles) ||
    !Array.isArray(value.testsRun) ||
    [...value.changedFiles, ...value.testsRun].some(
      (v) => typeof v !== "string",
    )
  )
    return;
  return structuredClone(value);
}
export class WorkerExecutor {
  private sequence = 0;
  constructor(
    private readonly options: {
      home: string;
      sessionId: string;
      cwd: string;
      runner: ChildRunner;
      worktrees: boolean;
      checks?(signal: AbortSignal): Promise<{ ok: boolean; output: string }>;
      changes: Changes;
      redact?(text: string): string;
    },
  ) {}
  async run(item: PlanItem, signal: AbortSignal) {
    let tree: Worktree | undefined;
    let cwd = this.options.cwd;
    if (this.options.worktrees) {
      let git = (await gitInfo(cwd)).git;
      try {
        if (git) await runGit(["rev-parse", "--show-toplevel"], cwd, signal);
      } catch {
        git = false;
        signal.throwIfAborted();
      }
      if (git) {
        if (await runGit(["status", "--porcelain"], cwd, signal))
          throw new Error(
            "Commit or resolve session changes before starting an isolated worker",
          );
        const branches = (
          await runGit(
            [
              "for-each-ref",
              "--format=%(refname:short)",
              `refs/heads/xh/${this.options.sessionId}-w*`,
            ],
            cwd,
            signal,
          )
        ).split("\n");
        for (const branch of branches) {
          const suffix = branch.slice(`xh/${this.options.sessionId}-w`.length);
          if (/^\d+$/.test(suffix))
            this.sequence = Math.max(this.sequence, Number(suffix));
        }
        const hooksPath = join(this.options.home, "empty-git-hooks");
        await mkdir(hooksPath, { recursive: true });
        tree = await new Repository(
          this.options.home,
          (args, root, signal, progress) =>
            runGit(
              ["-c", `core.hooksPath=${hooksPath}`, ...args],
              root,
              signal,
              progress,
            ),
        ).createWorktree(
          cwd,
          this.options.sessionId,
          `${this.options.sessionId}-w${++this.sequence}`,
          signal,
          undefined,
          `xh/${this.options.sessionId}-w${this.sequence}`,
        );
        cwd = tree.path;
      }
    }
    let done: WorkerReport | undefined;
    const tools: ToolRegistry = new Map();
    const reportDone: Tool = {
      spec: {
        name: "ReportDone",
        description: "Report completed implementation for harness integration",
        inputSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            changedFiles: { type: "array", items: { type: "string" } },
            testsRun: { type: "array", items: { type: "string" } },
          },
          required: ["summary", "changedFiles", "testsRun"],
          additionalProperties: false,
        },
      },
      readOnly: false,
      validate: async (input) =>
        done
          ? "Completion was already reported"
          : report(input)
            ? undefined
            : "Invalid ReportDone",
      execute: async (input) => {
        done = report(input);
        tools.clear();
        return { content: "Completion recorded; awaiting integration" };
      },
    };
    tools.set("ReportDone", reportDone);
    const result = await this.options.runner.run(
      "worker",
      {
        model: item.assignee.model,
        effort: item.assignee.effort,
        tools: ["Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob"],
      },
      `Plan item ${item.id}: ${item.title}\nInstructions: ${item.instructions}\nAllowed files: ${JSON.stringify(item.files)}\nAcceptance: ${item.acceptance}\nReturn ReportDone with summary, changedFiles and testsRun.`,
      cwd,
      signal,
      { files: item.files, reportTool: tools },
    );
    if (!done) throw new Error("Worker ended without ReportDone");
    this.options.changes.providers.add(result.provider);
    if (tree) {
      // No staging of arbitrary files from a model report: use Git's actual changed paths.
      const files = [
        await runGit(
          ["ls-files", "--modified", "--others", "--exclude-standard", "-z"],
          cwd,
          signal,
        ),
        await runGit(["diff", "--cached", "--name-only", "-z"], cwd, signal),
      ]
        .join("\0")
        .split("\0")
        .filter(Boolean);
      if (
        files.some((p) =>
          /(?:^|[/\\])(?:auth\.json|\.credentials\.json|\.env(?:\.[^/\\]*)?|id_rsa|id_ed25519)$/i.test(
            p,
          ),
        )
      )
        throw new Error("Secret files cannot be committed by workers");
      if (files.length) {
        for (const file of files) {
          try {
            const text = (await readFile(join(cwd, file))).toString("utf8");
            if (this.options.redact && this.options.redact(text) !== text)
              throw new Error("Worker files contain protected secrets");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await runGit(["add", "--", ...files], cwd, signal);
        const staged = await runGit(
          ["diff", "--cached", "--no-ext-diff", "--no-textconv"],
          cwd,
          signal,
        );
        if (staged.length >= 950_000)
          throw new Error("Worker diff exceeds the safe inspection limit");
        if (this.options.redact && this.options.redact(staged) !== staged)
          throw new Error("Worker changes contain protected secrets");
        const hooks = join(this.options.home, "empty-git-hooks");
        await mkdir(hooks, { recursive: true });
        await runGit(
          [
            "-c",
            `core.hooksPath=${hooks}`,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "user.name=XHarness",
            "-c",
            "user.email=xharness@localhost",
            "commit",
            "-m",
            `worker: ${item.id}`,
          ],
          cwd,
          signal,
        );
      }
      // Keep conflicts/worktrees for main to resolve; never force-remove work.
      if (
        (await runGit(
          ["rev-parse", "--abbrev-ref", "HEAD"],
          this.options.cwd,
          signal,
        )) !== tree.baseBranch ||
        (await runGit(["status", "--porcelain"], this.options.cwd, signal))
      )
        throw new Error(
          "Session branch changed or became dirty before integration",
        );
      const committedPaths = (
        await runGit(
          ["diff", "--name-only", `${tree.baseBranch}...${tree.branch}`],
          this.options.cwd,
          signal,
        )
      ).split("\n");
      if (
        committedPaths.some((p) =>
          /(?:^|[/\\])(?:auth\.json|\.credentials\.json|\.env(?:\.[^/\\]*)?|id_rsa|id_ed25519)$/i.test(
            p,
          ),
        )
      )
        throw new Error("Secret files cannot be integrated from workers");
      const committed = await runGit(
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          `${tree.baseBranch}...${tree.branch}`,
        ],
        this.options.cwd,
        signal,
      );
      if (committed.length >= 950_000)
        throw new Error(
          "Worker committed diff exceeds the safe inspection limit",
        );
      if (this.options.redact && this.options.redact(committed) !== committed)
        throw new Error("Worker commits contain protected secrets");
      await runGit(
        [
          "-c",
          `core.hooksPath=${join(this.options.home, "empty-git-hooks")}`,
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=XHarness",
          "-c",
          "user.email=xharness@localhost",
          "merge",
          "--no-edit",
          tree.branch,
        ],
        this.options.cwd,
        signal,
      );
    }
    const checks = await this.options.checks?.(signal);
    if (checks && !checks.ok)
      throw new Error(
        "Wave tests failed; main must investigate\n" + checks.output,
      );
    return { ...done, branch: tree?.branch, cwd };
  }
}
