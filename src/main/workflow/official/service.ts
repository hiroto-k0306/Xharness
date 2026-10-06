import {
  mkdir,
  writeFile,
  readFile,
  rename,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { withSessionTrace, withTaskTrace } from "../../core/trace.js";
import { redact } from "../../core/redact.js";
import {
  createSyntheticWorkspace,
  fixtureWorkflowOptions,
  fixtureAgents,
} from "./fixtures.js";
import {
  runOfficialSingleTask,
  resumeBlockReason,
  type WorkflowOptions,
  type WorkflowRecord,
} from "./runtime.js";
import { officialWorkflowReport } from "./report.js";
import { gitWorkspace } from "./workspace.js";
import { ClaudeWorkflowAgent } from "./claude.js";
import { CodexWorkflowAgent } from "./codex.js";
import { planContract } from "./contracts.js";
import { createDagWorkspace, dagWorkflowOptions } from "./dag-fixtures.js";
import { runOfficialDag, type DagOptions } from "./dag.js";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../../shared/official-workflow.js";

const uuid = (id: unknown): id is string =>
  typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id);
export class OfficialWorkflowService {
  private root: string;
  private records = new Map<string, WorkflowRecord>();
  private active?: {
    id: string;
    controller: AbortController;
    done: Promise<void>;
  };
  private approval?: {
    id: string;
    digest: string;
    accept: (accepted: boolean) => void;
  };
  private error?: string;
  private loading: Promise<void>;
  private busy = false;
  private storageReady = false;
  private preparing?: { id: string; controller: AbortController };
  constructor(
    private settings: {
      home: string;
      fake: boolean;
      codexPath?: string;
      options?: (
        cwd: string,
        provider: "claude" | "codex",
      ) => Promise<WorkflowOptions>;
    },
  ) {
    this.root = resolve(settings.home, "official-workflows");
    this.loading = this.load().catch(() => {
      this.error = "workflow保存領域を読み込めません。実行は停止しています。";
    });
  }
  private async load() {
    await mkdir(this.root, { recursive: true });
    if ((await realpath(this.root)).toLowerCase() !== this.root.toLowerCase())
      throw new Error("Linked workflow storage");
    this.storageReady = true;
    for (const id of (await readdir(this.root)).filter(uuid).slice(-50)) {
      try {
        const directory = join(this.root, id),
          file = join(directory, "workflow.json");
        if ((await lstat(directory)).isSymbolicLink()) continue;
        const stat = await lstat(file);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.nlink !== 1 ||
          stat.size > 2000000
        )
          continue;
        const record = JSON.parse(
          await readFile(file, "utf8"),
        ) as WorkflowRecord;
        if (
          record.version !== 1 ||
          record.id !== id ||
          typeof record.cwd !== "string" ||
          typeof record.simulated !== "boolean" ||
          ![
            "planning",
            "approval",
            "implementing",
            "verifying",
            "reviewing",
            "completed",
            "attention",
            "quota-paused",
            "cancelled",
            "failed",
            "interrupted",
          ].includes(record.status) ||
          ![
            "plan",
            "approval",
            "implement",
            "verify",
            "review",
            "fix",
            "complete",
          ].includes(record.next) ||
          typeof record.startedAt !== "string" ||
          !Number.isFinite(Date.parse(record.startedAt)) ||
          !Number.isInteger(record.correctionRounds) ||
          record.correctionRounds < 0 ||
          record.correctionRounds > (record.dag ? 34 : 2) ||
          !Array.isArray(record.calls) ||
          !Array.isArray(record.tools) ||
          !Array.isArray(record.checks) ||
          !Array.isArray(record.reviews) ||
          !Array.isArray(record.commits) ||
          typeof record.goal !== "string" ||
          record.goal.length > 4000 ||
          !/^[a-f0-9]{40,64}$/.test(record.head) ||
          !/^[a-f0-9]{40,64}$/.test(record.base)
        )
          continue;
        const rel = relative(directory, record.cwd);
        if (
          !rel ||
          rel.startsWith("..") ||
          rel.includes("/") ||
          rel.includes("\\") ||
          !rel.startsWith("workspace-")
        )
          continue;
        if (record.plan) record.plan = planContract.parse(record.plan);
        if (record.simulated !== this.settings.fake) continue;
        if (
          [
            "planning",
            "approval",
            "implementing",
            "verifying",
            "reviewing",
          ].includes(record.status)
        ) {
          record.status = "interrupted";
          record.error = "process-interrupted";
          await this.save(record);
        }
        this.records.set(id, record);
      } catch {
        this.error =
          "一部の保存状態を安全に読み込めませんでした。実行はしていません。";
      }
    }
  }
  view(): OfficialWorkflowView {
    return {
      available:
        this.storageReady && (this.settings.fake || !!this.settings.codexPath),
      simulated: this.settings.fake,
      activeId: this.active?.id ?? this.preparing?.id,
      approval: this.approval
        ? { id: this.approval.id, digest: this.approval.digest }
        : undefined,
      error: this.error,
      records: [...this.records.values()]
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
        .slice(0, 20)
        .map((record) => ({
          record: structuredClone(record),
          resumeBlocked: resumeBlockReason(record),
          reportHref: pathToFileURL(join(this.root, record.id, "report.html"))
            .href,
        })),
    };
  }
  private async save(record: WorkflowRecord) {
    const directory = join(this.root, record.id);
    await mkdir(directory, { recursive: true });
    if (
      (await realpath(directory)).toLowerCase() !==
      resolve(directory).toLowerCase()
    )
      throw new Error("Linked workflow storage");
    for (const [name, text] of [
      ["workflow.json", JSON.stringify(record, null, 2)],
      ["report.html", officialWorkflowReport(record)],
    ]) {
      const target = join(directory, name!),
        temporary = join(directory, `${randomUUID()}.tmp`);
      await writeFile(temporary, redact(text!), { mode: 0o600 });
      await rename(temporary, target);
    }
    this.records.set(record.id, structuredClone(record));
  }
  private async options(
    cwd: string,
    provider: "claude" | "codex",
    signal: AbortSignal,
    mode: "single" | "dag" = "single",
  ) {
    if (mode === "dag") {
      if (!this.settings.fake)
        throw new Error(
          "DAGは固定合成課題の模擬実行のみ対応しています。実provider並行実行は未検証です。",
        );
      return dagWorkflowOptions(cwd, resolve(cwd, ".."));
    }
    if (this.settings.options) return this.settings.options(cwd, provider);
    const options = fixtureWorkflowOptions(cwd, {
      agents: fixtureAgents(provider).agents,
      workspace: gitWorkspace(cwd, redact),
    });
    if (this.settings.fake) return options;
    if (!this.settings.codexPath)
      throw new Error("公式Codexの実行パスを設定してください");
    const claude = new ClaudeWorkflowAgent(),
      codex = CodexWorkflowAgent.local(this.settings.codexPath);
    const models = [
      ...(await codex.discover(cwd, signal)),
      ...(await claude.discover(cwd, signal)),
    ];
    const opus = models.find(
      (m) =>
        m.provider === "claude" &&
        (m.model === "opus" || m.resolvedModel?.includes("opus")) &&
        m.quotaAllowed === true,
    );
    const haiku = models.find(
      (m) =>
        m.provider === "claude" &&
        (m.model === "haiku" || m.resolvedModel?.includes("haiku")) &&
        m.quotaAllowed === true,
    );
    const review = models.find(
      (m) =>
        m.provider === "codex" &&
        m.model === "gpt-6.1-sol" &&
        m.quotaAllowed === true,
    );
    if (!opus || !review || (provider === "claude" && !haiku))
      throw new Error("必要な公式modelとincluded usageを確認できません");
    return {
      ...options,
      simulated: false,
      agents: { claude, codex },
      models: models.filter((m) => m === opus || m === haiku || m === review),
      planner: {
        model: opus.model,
        effort: opus.efforts.includes("high") ? ("high" as const) : null,
      },
      reviewers: {
        claude: {
          model: opus.model,
          effort: opus.efforts.includes("high") ? ("high" as const) : null,
        },
        codex: {
          model: review.model,
          effort: review.efforts.includes("low") ? ("low" as const) : null,
        },
      },
      goal: `Correct addition without modifying the test. Assign the one implementation task to ${provider}.`,
    } satisfies WorkflowOptions;
  }
  private launch(
    id: string,
    options: WorkflowOptions,
    resume?: WorkflowRecord,
  ) {
    const controller = new AbortController();
    options.id = id;
    options.resume = resume;
    options.save = (r) => this.save(r);
    options.approve = async (_plan, digest, signal) =>
      new Promise<boolean>((accept) => {
        const finish = (yes: boolean) => {
          signal.removeEventListener("abort", cancel);
          this.approval = undefined;
          accept(yes);
        };
        const cancel = () => finish(false);
        this.approval = { id, digest, accept: finish };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
      });
    const done = withSessionTrace(join(this.root, id), id, redact, () =>
      withTaskTrace(
        {
          model: options.planner.model,
          effort: options.planner.effort ?? undefined,
          taskId: id,
        },
        async () => {
          const record = await (
            "worktrees" in options ? runOfficialDag : runOfficialSingleTask
          )(options as DagOptions, controller.signal);
          return {
            ...record,
            stopCause:
              record.status === "completed"
                ? "workflow_complete"
                : record.status === "cancelled"
                  ? "aborted"
                  : "review_attention",
          };
        },
      ),
    )
      .then(() => {})
      .catch(() => {
        this.error =
          "安全に継続できません。保存状態と作業を保全し、再送を停止しました。";
      })
      .finally(() => {
        this.active = undefined;
        this.approval = undefined;
      });
    this.active = { id, controller, done };
  }
  async command(
    command: OfficialWorkflowCommand,
  ): Promise<OfficialWorkflowView> {
    await this.loading;
    if (command.action === "list") return this.view();
    if (command.action === "cancel") {
      if (this.preparing?.id === command.id) this.preparing.controller.abort();
      if (this.active?.id === command.id) {
        this.active.controller.abort();
        await this.active.done;
      }
      return this.view();
    }
    if (command.action === "approve") {
      if (
        this.approval?.id === command.id &&
        this.approval.digest === command.digest
      )
        this.approval.accept(true);
      return this.view();
    }
    if (this.active || this.busy)
      return { ...this.view(), error: "別のworkflowが実行中です" };
    this.busy = true;
    this.error = undefined;
    try {
      if (!this.storageReady) throw new Error("Unsafe workflow storage");
      if (command.action === "create") {
        if (command.mode === "dag" && !this.settings.fake)
          throw new Error("Native DAG is not enabled");
        const id = randomUUID(),
          directory = join(this.root, id);
        await mkdir(directory);
        const cwd =
          command.mode === "dag"
            ? (await createDagWorkspace(directory, directory)).cwd
            : await createSyntheticWorkspace("workspace-", directory);
        this.preparing = { id, controller: new AbortController() };
        const state = await gitWorkspace(cwd, redact).inspect(
          this.preparing.controller.signal,
        );
        const prepared: WorkflowRecord = {
          version: 1,
          id,
          simulated: this.settings.fake,
          cwd,
          goal: "Correct addition without modifying the test.",
          startedAt: new Date().toISOString(),
          status: "planning",
          next: "plan",
          base: state.head,
          head: state.head,
          correctionRounds: 0,
          calls: [],
          tools: [],
          checks: [],
          reviews: [],
          commits: [],
          ...(command.mode === "dag"
            ? {
                dag: {
                  maxParallel: 2 as const,
                  phase: "nodes" as const,
                  nodes: [],
                  nativeConversationResume: false as const,
                },
              }
            : {}),
        };
        await this.save(prepared);
        const options = await this.options(
          cwd,
          command.provider,
          this.preparing.controller.signal,
          command.mode,
        );
        options.startedAt = prepared.startedAt;
        this.preparing.controller.signal.throwIfAborted();
        this.launch(id, options);
      } else {
        const record = this.records.get(command.id);
        if (!record || resumeBlockReason(record))
          throw new Error("不確定な副作用または再開不能な段階です");
        const workspace = gitWorkspace(record.cwd, redact),
          current = await workspace.inspect(new AbortController().signal);
        if (!current.clean || current.head !== record.head)
          throw new Error("作業領域が保存状態と異なります");
        this.preparing = { id: record.id, controller: new AbortController() };
        const options = await this.options(
          record.cwd,
          record.plan!.tasks[0]!.assignee.provider,
          this.preparing.controller.signal,
          record.dag ? "dag" : "single",
        );
        this.preparing.controller.signal.throwIfAborted();
        options.goal = record.goal;
        this.launch(record.id, options, record);
      }
    } catch (error) {
      const prepared = this.preparing && this.records.get(this.preparing.id);
      if (prepared?.status === "planning" && !prepared.calls.length) {
        prepared.status = this.preparing?.controller.signal.aborted
          ? "cancelled"
          : "failed";
        prepared.error = this.preparing?.controller.signal.aborted
          ? "cancelled"
          : "connection-preflight-unavailable";
        prepared.finishedAt = new Date().toISOString();
        await this.save(prepared);
      }
      this.error =
        error instanceof Error &&
        /^(不確定|作業領域|必要な公式|公式Codex)/.test(error.message)
          ? error.message
          : "workflowを開始できませんでした。再送していません。";
    } finally {
      this.busy = false;
      this.preparing = undefined;
    }
    return this.view();
  }
  async close() {
    this.preparing?.controller.abort();
    this.active?.controller.abort();
    await this.active?.done;
  }
}
