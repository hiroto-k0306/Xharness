import { withSessionTrace } from "../core/trace.js";
import { type LoopOptions, runTurn } from "../core/loop.js";
import { planItemsSchema } from "./plan-schema.js";
import { type Tool, type ToolRegistry } from "../tools/registry.js";
import { type ChildOptions, ChildRunner } from "../agents/runner.js";
import { type AgentConfig } from "../agents/definitions.js";
import { loadModelCatalog } from "../config/model-catalog.js";
import { resolveModel } from "../config/config.js";
import { type ProviderId } from "../core/types.js";
import { type PlanItem, validatePlan } from "./plan-validate.js";
import { SerialScheduler } from "./scheduler.js";
import { WorkerExecutor } from "./worker.js";
import { Changes, gitDiff } from "./changes.js";
import { WorkflowState, findings } from "./state.js";
import { runGit } from "../session/repository.js";
import { gitInfo } from "../session/store.js";
import { decidePermission } from "../core/permissions.js";
import { type ToolCall } from "../tools/registry.js";
import { shellHooks, type ShellHook } from "../hooks/shell-hooks.js";
import { shellSearchTools } from "../tools/shell-search.js";
import { AgentTasks } from "../agents/tasks.js";
import { lifecycleTools } from "../tools/lifecycle.js";
import { todoTools } from "../tools/todos.js";

export interface RuntimeOptions extends ChildOptions {
  approveHooks?(
    hooks: readonly ShellHook[],
    signal: AbortSignal,
  ): Promise<boolean>;
  cwd: string;
  config: AgentConfig;
  approve(
    items: PlanItem[],
    notes: string,
    warnings: string[],
    signal: AbortSignal,
  ): Promise<boolean>;
  waveChecks?(signal: AbortSignal): Promise<{ ok: boolean; output: string }>;
  onPhase?(state: {
    phase: string;
    reviewRound: number;
    items: ReturnType<SerialScheduler["snapshot"]>;
    findings: WorkflowState["findings"];
  }): void;
  quota?: Partial<Record<ProviderId, number>>;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid arguments");
  return value as Record<string, unknown>;
}
async function writes(call: ToolCall, cwd: string): Promise<boolean> {
  return (
    ["Write", "Edit", "MultiEdit", "SubmitPlan", "SkipPlan"].includes(
      call.name,
    ) ||
    (call.name === "Bash" &&
      (await decidePermission(call, { mode: "plan", rules: [] }, cwd)) ===
        "deny")
  );
}
export class WorkflowRuntime {
  private fileCheckpoint?: LoopOptions["checkpoint"];
  manualReview = false;
  private queuedPhase?: string;
  queuePhase(phase: string) {
    if (!["plan", "implement", "review"].includes(phase))
      throw new Error("Unknown phase");
    this.queuedPhase = phase;
  }
  manualPhase(phase: string) {
    if (!["plan", "implement", "review"].includes(phase))
      throw new Error("Unknown phase");
    if (phase === "review") {
      if (this.scheduler?.snapshot().some((i) => i.status !== "integrated"))
        throw new Error("Review requires integrated items");
      this.manualReview = true;
      this.state.phase = "implement";
    } else {
      if (phase === "plan" && this.activeMain) {
        this.scheduler?.fail(this.activeMain.id);
        this.activeMain = undefined;
        this.mainRoute = undefined;
      }
      this.state.phase = phase === "plan" ? "plan" : "implement";
    }
    this.notify();
  }
  readonly state: WorkflowState;
  readonly changes: Changes;
  private readonly runner: ChildRunner;
  private readonly tasks: AgentTasks;
  private readonly worker: WorkerExecutor;
  private scheduler?: SerialScheduler;
  private items: PlanItem[] = [];
  private activeMain?: PlanItem;
  private mainRoute?: {
    model: string;
    reasoning?: { effort: PlanItem["assignee"]["effort"] };
  };
  get mainModel() {
    return this.mainRoute?.model;
  }
  private base?: string;
  private initialized = false;
  private interrupted = false;
  constructor(private readonly options: RuntimeOptions) {
    this.state = new WorkflowState(
      options.config.workflow.mode,
      options.config.workflow.reviewRounds,
    );
    this.changes = new Changes(options.cwd);
    this.tasks = new AgentTasks((id, a, signal) => {
      const definition = this.options.config.agents[String(a.agent)]!;
      return this.runner.run(
        String(a.agent),
        {
          ...definition,
          model: typeof a.model === "string" ? a.model : definition.model,
        },
        String(a.prompt),
        this.options.cwd,
        signal,
        undefined,
        id,
      );
    });
    this.runner = new ChildRunner({
      ...options,
      checkpoint: (cwd) =>
        cwd === options.cwd ? this.fileCheckpoint : undefined,
      hooks: (context, onReceipt) =>
        shellHooks({
          hooks: options.config.hooks ?? [],
          cwd: context.cwd,
          agent: context.name,
          phase: () => this.state.phase,
          bash: shellSearchTools(context.cwd).get("Bash")!,
          approve: (signal) =>
            options.approveHooks?.(options.config.hooks ?? [], signal) ??
            Promise.resolve(false),
          redact: options.redact,
          onReceipt,
        }),
      createTools: (cwd) =>
        cwd === options.cwd
          ? this.changes.wrap(options.createTools(cwd))
          : options.createTools(cwd),
    });
    this.worker = new WorkerExecutor({
      home: options.home,
      sessionId: options.parentId,
      cwd: options.cwd,
      runner: this.runner,
      worktrees: options.config.workflow.worktrees,
      changes: this.changes,
      checks: options.waveChecks,
      redact: options.redact,
    });
  }
  private notify() {
    this.options.onPhase?.({
      phase: this.state.phase,
      reviewRound: this.state.reviewRound,
      items: (this.scheduler?.snapshot() ?? []).map((status) => {
        const item = this.items.find((i) => i.id === status.id);
        return {
          ...status,
          title: item?.title,
          model: item?.assignee.model,
          agent: item?.assignee.agent,
        };
      }),
      findings: this.state.findings,
    });
  }
  private async diff(signal: AbortSignal) {
    const diff = [
      this.base ? await gitDiff(this.options.cwd, this.base, signal) : "",
      await this.changes.diff(),
    ]
      .filter(Boolean)
      .join("\n");
    if (diff.length > 900_000)
      throw new Error("Review diff exceeds the safe limit; split the plan");
    return (this.options.redact ?? ((s: string) => s))(diff);
  }
  private tool(
    name: string,
    properties: Record<string, unknown>,
    required: string[],
    validate: (input: Record<string, unknown>) => string | undefined,
    execute: (
      input: Record<string, unknown>,
      signal: AbortSignal,
    ) => Promise<string>,
  ): Tool {
    return {
      spec: {
        name,
        description:
          name === "Task"
            ? "Delegate investigation/review to a configured child agent. background=true returns a taskId immediately; use TaskList/TaskOutput/TaskStop to manage it. At most 3 run concurrently. Running children are cancelled when this parent turn ends; collect results before finishing. Workers are managed by SubmitPlan, not Task."
            : name + " is managed by the harness workflow",
        inputSchema: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
      readOnly: false,
      validate: async (input) => {
        try {
          const args = object(input);
          if (Object.keys(args).some((k) => !Object.hasOwn(properties, k)))
            return "Unknown argument";
          return validate(args);
        } catch {
          return "Invalid arguments";
        }
      },
      execute: async (input, signal) => {
        try {
          const error = validate(object(input));
          if (error) return { content: error, isError: true };
          return { content: await execute(object(input), signal) };
        } catch (error) {
          if (signal.aborted) throw error;
          return {
            content:
              error instanceof Error
                ? (this.options.redact ?? ((s: string) => s))(error.message)
                : "Workflow operation failed",
            isError: true,
          };
        }
      },
    };
  }
  private async dispatch(signal: AbortSignal): Promise<string> {
    const reports: string[] = [];
    while (this.scheduler) {
      const item = this.scheduler.startNext();
      if (!item) break;
      this.notify();
      if (item.assignee.agent === "main") {
        this.activeMain = item;
        this.mainRoute = {
          model: resolveModel(item.assignee.model, this.options.aliases)!.model,
          reasoning: { effort: item.assignee.effort },
        };
        reports.push(
          `Main must implement ${JSON.stringify(item)} then call UpdatePlan({itemIndex:${this.items.findIndex((i) => i.id === item.id)},status:"completed"}).`,
        );
        break;
      }
      try {
        reports.push(JSON.stringify(await this.worker.run(item, signal)));
        this.scheduler.integrated(item.id);
      } catch (error) {
        this.scheduler.fail(item.id);
        reports.push(
          `${item.id} failed: ${error instanceof Error ? error.message : "Worker failure"}. Main must investigate, resolve conflicts or tests, then UpdatePlan with status completed or retry.`,
        );
        this.notify();
        break;
      }
      this.notify();
    }
    return (
      reports.join("\n") ||
      "All assignments are integrated; call RequestReview after inspecting the result."
    );
  }
  private registry(base: ToolRegistry): ToolRegistry {
    base = new Map(
      [...base].map(([name, tool]) => [
        name,
        !tool.readOnly
          ? {
              ...tool,
              validate: async (input: unknown) =>
                ["implement", "off"].includes(this.state.phase) ||
                (name === "Bash" &&
                  ["classify", "plan"].includes(this.state.phase))
                  ? tool.validate(input)
                  : "Writes are unavailable in this workflow phase",
            }
          : tool,
      ]),
    );
    // preserved thinking: Opus/Sonnet 5.5 は system と tools を「過去の thinking の前提」として検査し、
    // 変わると 400 になる。段階によってツールを出し入れせず、毎回同じ集合・同じ順で渡し、
    // 段階による制限は validate(STEP 3 と実行直前)で行う。
    const result = new Map(base);
    for (const [name, tool] of lifecycleTools()) result.set(name, tool);
    for (const [name, tool] of todoTools()) result.set(name, tool);
    for (const [name, tool] of this.tasks.tools()) result.set(name, tool);
    const workflowTools = this.options.config.workflow.mode !== "off";
    const gated = (
      tool: Tool,
      unavailable: () => string | undefined,
    ): Tool => ({
      ...tool,
      validate: async (input: unknown) =>
        unavailable() ?? (await tool.validate(input)),
    });
    result.set(
      "Task",
      this.tool(
        "Task",
        {
          description: { type: "string" },
          prompt: { type: "string" },
          agent: { type: "string" },
          model: { type: "string" },
          background: { type: "boolean" },
        },
        ["description", "prompt", "agent"],
        (a) =>
          [a.description, a.prompt, a.agent].every(
            (s) => typeof s === "string" && s.trim(),
          ) &&
          (a.model === undefined || typeof a.model === "string") &&
          (a.background === undefined || typeof a.background === "boolean") &&
          Object.hasOwn(this.options.config.agents, String(a.agent))
            ? undefined
            : "Unknown agent or invalid Task",
        async (a, signal) => {
          if (a.background === true) return this.tasks.start(a, signal);
          const definition = this.options.config.agents[String(a.agent)]!;
          return (
            await this.runner.run(
              String(a.agent),
              {
                ...definition,
                model: typeof a.model === "string" ? a.model : definition.model,
              },
              String(a.prompt),
              this.options.cwd,
              signal,
            )
          ).text;
        },
      ),
    );
    if (workflowTools)
      result.set(
        "SubmitPlan",
        gated(
          this.tool(
            "SubmitPlan",
            {
              items: planItemsSchema,
              notes: { type: "string" },
            },
            ["items", "notes"],
            (a) =>
              typeof a.notes !== "string"
                ? "notes is required"
                : validatePlan(a.items, loadModelCatalog(), {
                    aliases: this.options.aliases,
                    fiveHourUsedPercent: this.options.quota,
                  }).errors.join("\n") || undefined,
            async (a, signal) => {
              const items = structuredClone(a.items) as PlanItem[];
              const validation = validatePlan(items, loadModelCatalog(), {
                aliases: this.options.aliases,
                fiveHourUsedPercent: this.options.quota,
              });
              if (
                this.scheduler?.snapshot().some((i) => i.status === "running")
              )
                throw new Error(
                  "Finish the running assignment before replacing the plan",
                );
              if (
                this.options.config.workflow.planApproval === "ask" &&
                !(await this.options.approve(
                  items,
                  String(a.notes),
                  validation.warnings,
                  signal,
                ))
              ) {
                this.state.phase = "plan";
                this.interrupted = true;
                return "Plan rejected or needs revision. Wait for user instructions.";
              }
              signal.throwIfAborted();
              const approved = validatePlan(items, loadModelCatalog(), {
                aliases: this.options.aliases,
                fiveHourUsedPercent: this.options.quota,
              });
              if (approved.errors.length)
                throw new Error("Invalid approved plan");
              this.items = items;
              this.scheduler = new SerialScheduler(items, loadModelCatalog(), {
                aliases: this.options.aliases,
              });
              this.state.approve();
              this.notify();
              return (
                validation.warnings.join("\n") +
                "\n" +
                (await this.dispatch(signal))
              );
            },
          ),
          () =>
            ["classify", "plan", "implement"].includes(this.state.phase) &&
            !this.activeMain
              ? undefined
              : "SubmitPlan is unavailable in this workflow phase or while a plan item is in progress",
        ),
      );
    if (workflowTools)
      result.set(
        "SkipPlan",
        gated(
          this.tool(
            "SkipPlan",
            { reason: { type: "string" } },
            ["reason"],
            (a) =>
              typeof a.reason === "string" && a.reason.trim()
                ? undefined
                : "reason is required",
            async () => {
              this.state.approve();
              this.notify();
              return "Implement a small fix. RequestReview remains required.";
            },
          ),
          () =>
            ["classify", "plan"].includes(this.state.phase)
              ? undefined
              : "SkipPlan is only available before implementation",
        ),
      );
    const implementOnly = (name: string) => () =>
      this.state.phase === "implement"
        ? undefined
        : `${name} is only available in the implement phase`;
    if (workflowTools) {
      result.set(
        "UpdatePlan",
        gated(
          this.tool(
            "UpdatePlan",
            {
              itemIndex: { type: "integer" },
              status: {
                type: "string",
                enum: ["completed", "retry", "running"],
              },
            },
            ["itemIndex", "status"],
            (a) =>
              Number.isSafeInteger(a.itemIndex) &&
              !!this.items[Number(a.itemIndex)] &&
              ["completed", "retry", "running"].includes(String(a.status))
                ? undefined
                : "Invalid item progress",
            async (a, signal) => {
              const item = this.items[Number(a.itemIndex)]!;
              const status = this.scheduler!.snapshot().find(
                (i) => i.id === item.id,
              )?.status;
              if (a.status === "running")
                return JSON.stringify(this.scheduler!.snapshot());
              if (a.status === "retry") {
                this.scheduler!.retry(item.id);
                return this.dispatch(signal);
              }
              if (item.id !== this.activeMain?.id && status !== "failed")
                throw new Error(
                  "Only main work or a failed integration can be completed by main",
                );
              const checks = await this.options.waveChecks?.(signal);
              if (checks && !checks.ok)
                throw new Error("Wave tests failed\n" + checks.output);
              if (
                this.base &&
                (await runGit(
                  ["diff", "--name-only", "--diff-filter=U"],
                  this.options.cwd,
                  signal,
                ))
              )
                throw new Error(
                  "Resolve merge conflicts before completing the item",
                );
              if (status === "failed") this.scheduler!.resolveFailure(item.id);
              else this.scheduler!.integrated(item.id);
              this.activeMain = undefined;
              this.mainRoute = undefined;
              this.notify();
              return this.dispatch(signal);
            },
          ),
          implementOnly("UpdatePlan"),
        ),
      );
      result.set(
        "RequestReview",
        gated(
          this.tool(
            "RequestReview",
            { summary: { type: "string" } },
            ["summary"],
            (a) =>
              typeof a.summary === "string" && a.summary.trim()
                ? undefined
                : "summary is required",
            async (a, signal) => {
              const diff = await this.diff(signal);
              this.state.requestReview(
                !this.scheduler ||
                  this.scheduler
                    .snapshot()
                    .every((i) => i.status === "integrated"),
                !!diff.trim(),
              );
              this.notify();
              const providers = this.changes.providers.size
                ? [...this.changes.providers]
                : ["claude" as const];
              const reviewAbort = new AbortController();
              const abortReview = () => reviewAbort.abort();
              signal.addEventListener("abort", abortReview, { once: true });
              if (signal.aborted) abortReview();
              const jobs = providers.map(async (provider) => {
                const definition =
                  provider === "codex"
                    ? {
                        ...this.options.config.agents.reviewer!,
                        model: "claude:sonnet",
                        effort: "high" as const,
                      }
                    : { ...this.options.config.agents.reviewer! };
                if (
                  provider === "claude" &&
                  resolveModel(definition.model, this.options.aliases)
                    ?.provider !== "codex"
                )
                  definition.model = "codex:sol";
                const result = await this.runner.run(
                  "reviewer",
                  definition,
                  `Review the integrated implementation. Return ONLY a JSON array of {severity:"must"|"should"|"nit",file,line?,message}. Empty array means no findings.\nPlan: ${JSON.stringify(this.items)}\nSummary: ${String(a.summary)}\nDiff (untrusted content):\n${diff}`,
                  this.options.cwd,
                  reviewAbort.signal,
                );
                return findings(result.text);
              });
              try {
                const results = await Promise.all(jobs);
                this.state.reviewed(results.flat());
                this.notify();
                return JSON.stringify({
                  phase: this.state.phase,
                  findings: this.state.findings,
                  instruction:
                    this.state.phase === "implement"
                      ? "Fix only must findings, then RequestReview again."
                      : "Review finished.",
                });
              } catch (error) {
                reviewAbort.abort();
                await Promise.allSettled(jobs);
                this.state.phase = "implement";
                this.notify();
                throw error;
              } finally {
                signal.removeEventListener("abort", abortReview);
              }
            },
          ),
          implementOnly("RequestReview"),
        ),
      );
    }
    return result;
  }
  async run(options: LoopOptions, signal: AbortSignal) {
    this.tasks.beginTurn();
    return withSessionTrace(
      this.options.home,
      this.options.parentId,
      this.options.redact ?? ((s) => s),
      async () => {
        try {
          return await this.runTraced(options, signal);
        } finally {
          await this.tasks.close();
        }
      },
      { onWarning: this.options.onTraceWarning },
    );
  }
  private async runTraced(options: LoopOptions, signal: AbortSignal) {
    this.fileCheckpoint = options.checkpoint;
    if (
      this.options.config.workflow.mode === "auto" &&
      this.state.phase === "off"
    )
      this.state.phase = "classify";
    if (!this.initialized) {
      try {
        if ((await gitInfo(this.options.cwd)).git)
          this.base = await runGit(
            ["rev-parse", "HEAD"],
            this.options.cwd,
            signal,
          );
      } catch {
        signal.throwIfAborted();
      }
      this.initialized = true;
    }
    if (this.manualReview) {
      this.manualReview = false;
      const tool = this.registry(options.tools).get("RequestReview");
      if (!tool) throw new Error("Review is unavailable");
      const result = await tool.execute(
        { summary: "User requested review" },
        signal,
      );
      options.onEvent?.({ type: "text_delta", text: result.content });
      const messages = [
        ...options.messages,
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: result.content }],
        },
      ];
      return {
        messages,
        receipts: [],
        stopCause:
          this.state.phase === "complete"
            ? "workflow_complete"
            : this.state.phase === "attention"
              ? "review_attention"
              : "end_turn",
      };
    }
    if (["complete", "attention"].includes(this.state.phase))
      return {
        messages: options.messages,
        receipts: [],
        stopCause:
          this.state.phase === "complete"
            ? "workflow_complete"
            : "review_attention",
      };
    this.interrupted = false;
    const base = this.changes.wrap(options.tools);
    const tools = new Map(base);
    let lastSelection = options.current?.().model ?? options.model;
    const current = () => {
      const selection = options.current?.();
      if (selection && selection.model !== lastSelection) {
        lastSelection = selection.model;
        this.mainRoute = undefined;
      }
      return (
        this.mainRoute ??
        selection ?? { model: options.model, reasoning: options.reasoning }
      );
    };
    this.notify();
    const hooks = shellHooks({
      hooks: this.options.config.hooks ?? [],
      cwd: this.options.cwd,
      agent: "main",
      phase: () => this.state.phase,
      bash: shellSearchTools(this.options.cwd).get("Bash")!,
      approve: (signal) =>
        this.options.approveHooks?.(this.options.config.hooks ?? [], signal) ??
        Promise.resolve(false),
      redact: options.redact,
      onReceipt: (receipt) => options.onEvent?.({ type: "receipt", receipt }),
    });
    let invalidPlanAttempts = 0;
    let previousProgress = "";
    let stalledCompletions = 0;
    return runTurn(
      {
        ...options,
        onEvent: (event) => {
          if (
            event.type === "receipt" &&
            event.receipt.tool === "SubmitPlan" &&
            event.receipt.decision === "error"
          )
            invalidPlanAttempts++;
          options.onEvent?.(event);
        },
        router: options.router ?? this.options.router,
        current,
        onFallback: async (route) => {
          if (this.activeMain)
            this.mainRoute = { model: route.model, reasoning: route.reasoning };
          await options.onFallback?.(route);
          lastSelection = options.current?.().model ?? options.model;
        },
        tools,
        // system も段階によらず同じ文にする(上の registry と同じ理由)
        system:
          options.system +
          (this.options.config.workflow.mode === "off"
            ? ""
            : `\nWorkflow: ${this.options.config.workflow.mode}. For file changes call SubmitPlan or SkipPlan before edits. RequestReview is mandatory after integration. Available enabled models: ${JSON.stringify(loadModelCatalog().filter((m) => m.enabled))}`),
        permission: async (call, signal) => {
          if (
            [
              "Task",
              "SubmitPlan",
              "SkipPlan",
              "UpdatePlan",
              "RequestReview",
              "TaskList",
              "TaskOutput",
              "TaskStop",
            ].includes(call.name)
          )
            return true;
          if (
            ["classify", "plan"].includes(this.state.phase) &&
            !tools.get(call.name)?.readOnly
          ) {
            if (call.name !== "Bash") return false;
            if (
              (await decidePermission(
                call,
                { mode: "plan", rules: [] },
                this.options.cwd,
              )) === "deny"
            )
              return false;
          }
          const allowed = await options.permission(call, signal);
          if (allowed && (await writes(call, this.options.cwd)))
            this.changes.providers.add(
              resolveModel(current().model)?.provider ?? options.provider.id,
            );
          return allowed;
        },
        beforeStep: async (step, ctx, signal) => {
          if (step === "context") {
            tools.clear();
            for (const [name, tool] of this.registry(base))
              tools.set(name, tool);
          }
          const result = await hooks.beforeStep(step, ctx, signal);
          if (result.kind !== "continue") return result;
          return (
            (await options.beforeStep?.(step, ctx, signal)) ?? {
              kind: "continue",
            }
          );
        },
        afterStep: async (step, ctx, signal) => {
          const shell = await hooks.afterStep(step, ctx, signal);
          if (shell.kind === "stop" || shell.kind === "block") return shell;
          const existing = await options.afterStep?.(step, ctx, signal);
          if (existing?.kind === "stop" || existing?.kind === "block")
            return existing;
          if (step === "receipt" && invalidPlanAttempts >= 3)
            return { kind: "stop", reason: "plan_validation_failed" };
          let extra = [shell, existing]
            .flatMap((r) => (r?.kind === "inject" ? [r.message] : []))
            .join("\n");
          let custom = extra
            ? { kind: "inject" as const, message: extra }
            : { kind: "continue" as const };
          if (step === "model" && this.state.phase === "classify") {
            for (const block of ctx.completion?.message.content ?? [])
              if (
                block.type === "tool_use" &&
                [
                  "Write",
                  "Edit",
                  "MultiEdit",
                  "SubmitPlan",
                  "SkipPlan",
                ].includes(block.name)
              ) {
                this.state.phase = "plan";
                this.notify();
                break;
              }
          }
          if (step !== "receipt") return custom;
          if (this.queuedPhase && !signal.aborted) {
            const phase = this.queuedPhase;
            this.queuedPhase = undefined;
            try {
              this.manualPhase(phase);
              if (phase === "review") {
                this.manualReview = false;
                const reviewed = await this.registry(base)
                  .get("RequestReview")!
                  .execute({ summary: "User requested review" }, signal);
                extra += "\n" + reviewed.content;
              }
              custom = {
                kind: "inject",
                message: extra || `User selected phase ${phase}`,
              };
            } catch {
              custom = {
                kind: "inject",
                message:
                  "Requested phase could not be entered: finish and integrate all plan items before review.",
              };
            }
          }
          if (this.interrupted)
            return { kind: "stop", reason: "plan_rejected" };
          if (this.state.phase === "complete")
            return { kind: "stop", reason: "workflow_complete" };
          if (this.state.phase === "attention")
            return { kind: "stop", reason: "review_attention" };
          if (ctx.stopCause || ctx.completion?.stopReason !== "end_turn")
            return custom;
          const diff = await this.diff(signal);
          // An end_turn with no plan or changes is a proposal or a blocked task,
          // not an instruction to invent a change merely to pass review.
          if (
            this.options.config.workflow.mode === "auto" &&
            !this.items.length &&
            !diff &&
            ["classify", "implement"].includes(this.state.phase)
          ) {
            this.state.phase = "off";
            this.notify();
            return custom;
          }
          const progress = JSON.stringify({
            phase: this.state.phase,
            items: this.scheduler?.snapshot() ?? [],
            reviewRound: this.state.reviewRound,
            diff,
          });
          stalledCompletions =
            progress === previousProgress ? stalledCompletions + 1 : 0;
          previousProgress = progress;
          if (
            ["plan", "implement"].includes(this.state.phase) &&
            stalledCompletions >= 2
          )
            return { kind: "stop", reason: "workflow_stalled" };
          if (this.state.phase === "classify") {
            this.state.phase = "off";
            this.notify();
            return custom;
          }
          if (this.state.phase === "plan")
            return {
              kind: "inject",
              message:
                "SubmitPlan or SkipPlan is required before implementation." +
                (extra ? "\n" + extra : ""),
            };
          if (this.state.phase === "implement")
            return {
              kind: "inject",
              message:
                "Implementation is not complete until all items are integrated and RequestReview succeeds. " +
                JSON.stringify(this.scheduler?.snapshot() ?? []) +
                (extra ? "\n" + extra : ""),
            };
          return custom;
        },
      },
      signal,
    );
  }
}
