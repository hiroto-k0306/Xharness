import { randomUUID } from "node:crypto";
import { verifyDagIntegration } from "./dag-integration.js";
import { runDagAgent } from "./dag-call.js";
import { withTraceFields } from "../../core/trace.js";
import {
  digest,
  runOfficialSingleTask,
  resumeBlockReason,
  type WorkflowOptions,
  type WorkflowRecord,
} from "./runtime.js";
import {
  validateOfficialPlan,
  WorkflowFailure,
  schemas,
  type OfficialPlan,
} from "./contracts.js";
import { OfficialWorktrees } from "./worktrees.js";
export interface DagNode {
  id: string;
  state:
    | "pending"
    | "creating"
    | "running"
    | "completed"
    | "integrating"
    | "integrated"
    | "stopped";
  cwd?: string;
  base?: string;
  record?: WorkflowRecord;
  integratedHead?: string;
}
export interface DagState {
  maxParallel: 2;
  phase: "nodes" | "integration" | "complete";
  nodes: DagNode[];
  integration?: WorkflowRecord;
  nativeConversationResume: false;
  crossReviewPending?: boolean;
  crossReviewedHead?: string;
}
export interface DagOptions extends WorkflowOptions {
  /** The mock DAG always plans, so its planner is required. */
  planner: NonNullable<WorkflowOptions["planner"]>;
  worktrees: OfficialWorktrees;
  /** Fresh guard at every wave; unknown/insufficient stops all new starts. */
  canStart?: (
    task: OfficialPlan["tasks"][number],
    signal: AbortSignal,
  ) => Promise<boolean | null>;
}
function executionDigest(options: WorkflowOptions) {
  return digest({
    goal: options.goal,
    files: options.files,
    tests: options.tests,
    integrationTests: options.integrationTests,
  });
}
export function dagResumeBlockReason(record: WorkflowRecord): string | null {
  const dag = record.dag;
  if (!dag || !record.executionDigest || !record.plan)
    return "dag-not-checkpointed";
  if (
    dag.maxParallel !== 2 ||
    dag.nativeConversationResume !== false ||
    !["nodes", "integration", "complete"].includes(dag.phase) ||
    !Array.isArray(dag.nodes) ||
    dag.nodes.length !== record.plan.tasks.length ||
    dag.nodes.some(
      (n) =>
        !n ||
        !record.plan!.tasks.some((t) => t.id === n.id) ||
        ![
          "pending",
          "creating",
          "running",
          "completed",
          "integrating",
          "integrated",
          "stopped",
        ].includes(n.state),
    ) ||
    new Set(dag.nodes.map((n) => n.id)).size !== dag.nodes.length
  )
    return "invalid-dag-state";
  if (
    record.status === "completed" ||
    record.status === "attention" ||
    dag.phase === "complete"
  )
    return "terminal-workflow";
  if (dag.crossReviewPending) return "uncertain-effect";
  if (
    record.pendingEffect ||
    record.calls.some((c) => c.status === "running") ||
    dag.nodes.some((n) => n.state === "creating" || n.state === "integrating")
  )
    return "uncertain-effect";
  if (record.approvedDigest && record.approvedDigest !== digest(record.plan))
    return "approval-digest-changed";
  for (const node of dag.nodes) {
    if (
      node.record &&
      (node.record.dag ||
        node.record.cwd !== node.cwd ||
        node.record.base !== node.base ||
        node.record.id !== record.id ||
        !Array.isArray(node.record.calls) ||
        !Array.isArray(node.record.checks))
    )
      return "invalid-node-checkpoint";
    if (node.record && !["completed", "integrated"].includes(node.state)) {
      const reason = resumeBlockReason(node.record);
      if (reason) return reason;
    }
  }
  if (dag.integration && dag.integration.status !== "completed")
    return resumeBlockReason(dag.integration);
  return null;
}
export function checkpoint(
  options: WorkflowOptions,
  base: string,
  plan: OfficialPlan,
  id: string,
): WorkflowRecord {
  return {
    version: 1,
    id,
    simulated: options.simulated === true,
    cwd: options.cwd,
    goal: options.goal,
    startedAt: new Date().toISOString(),
    status: "implementing",
    next: "implement",
    base,
    head: base,
    plan,
    approvedDigest: digest(plan),
    executionDigest: executionDigest(options),
    correctionRounds: 0,
    calls: [],
    tools: [],
    checks: [],
    reviews: [],
    commits: [],
  };
}

/** X-owned DAG: independent native loops, max two, serial durable import. */
export async function runOfficialDag(
  options: DagOptions,
  signal: AbortSignal,
): Promise<WorkflowRecord> {
  if (
    options.simulated !== true ||
    options.models.some((m) => m.capabilitySource !== "fixture")
  )
    throw new WorkflowFailure("native-dag-not-enabled");
  const initial = await options.workspace.inspect(signal);
  if (!initial.clean) throw new WorkflowFailure("dirty-workspace");
  if (
    options.resume &&
    (options.resume.executionDigest !== executionDigest(options) ||
      options.resume.head !== initial.head ||
      options.resume.cwd !== options.cwd ||
      dagResumeBlockReason(options.resume))
  )
    throw new WorkflowFailure("unsafe-dag-resume");
  const record: WorkflowRecord = options.resume
    ? structuredClone(options.resume)
    : {
        version: 1,
        id: options.id ?? randomUUID(),
        simulated: options.simulated === true,
        cwd: options.cwd,
        goal: options.goal,
        startedAt: options.startedAt ?? new Date().toISOString(),
        status: "planning",
        next: "plan",
        base: initial.head,
        head: initial.head,
        correctionRounds: 0,
        calls: [],
        tools: [],
        checks: [],
        reviews: [],
        commits: [],
        executionDigest: executionDigest(options),
        dag: {
          maxParallel: 2,
          phase: "nodes",
          nodes: [],
          nativeConversationResume: false,
        },
      };
  if (options.resume) {
    record.resumed = (record.resumed ?? 0) + 1;
    delete record.error;
    delete record.finishedAt;
  }
  let tail = Promise.resolve();
  const primary = record.calls.filter((c) => !c.nodeId),
    primaryTools = record.tools.filter((t) =>
      primary.some((c) => c.requestId === t.requestId),
    );
  const save = () => {
    record.correctionRounds =
      record.dag!.nodes.reduce(
        (total, n) => total + (n.record?.correctionRounds ?? 0),
        0,
      ) + (record.dag!.integration?.correctionRounds ?? 0);
    record.calls = [
      ...primary,
      ...record.dag!.nodes.flatMap((n) =>
        (n.record?.calls ?? []).map((c) => ({ ...c, nodeId: n.id })),
      ),
      ...(record.dag!.integration?.calls ?? []).map((c) => ({
        ...c,
        nodeId: "integration",
      })),
    ];
    record.tools = [
      ...primaryTools,
      ...record.dag!.nodes.flatMap((n) => n.record?.tools ?? []),
      ...(record.dag!.integration?.tools ?? []),
    ];
    record.checks = [
      ...record.dag!.nodes.flatMap((n) => n.record?.checks ?? []),
      ...(record.dag!.integration?.checks ?? []),
    ];
    record.reviews = [
      ...record.dag!.nodes.flatMap((n) => n.record?.reviews ?? []),
      ...(record.dag!.integration?.reviews ?? []),
    ];
    const snapshot = structuredClone(record);
    const pending = tail.then(() => options.save(snapshot));
    tail = pending;
    return pending;
  };
  const stable = async () => {
    const state = await options.workspace.inspect(signal);
    if (!state.clean || state.head !== record.head)
      throw new WorkflowFailure("dag-workspace-changed");
  };
  try {
    if (!record.plan) {
      const planner = options.models.find(
        (m) =>
          m.provider === "claude" &&
          m.model === options.planner.model &&
          m.available &&
          m.quotaAllowed === true &&
          m.efforts.includes(options.planner.effort),
      );
      if (!planner) throw new WorkflowFailure("unavailable-model");
      const requestId = randomUUID(),
        entry = {
          requestId,
          phase: "plan" as const,
          provider: planner.provider,
          requestedModel: planner.model,
          effort: options.planner.effort,
          status: "running" as const,
        };
      primary.push(entry);
      await save();
      const result = await runDagAgent(
        options.agents.claude,
        {
          requestId,
          taskId: record.id,
          phase: "plan",
          cwd: options.cwd,
          model: planner,
          effort: options.planner.effort,
          prompt: JSON.stringify({
            goal: options.goal,
            allowedFiles: options.files,
            acceptanceTests: options.tests.map((t) => ({
              id: t.id,
              command: t.command,
            })),
            availableModels: options.models.filter(
              (m) => m.available && m.quotaAllowed === true,
            ),
            instruction:
              "Read-only DAG planner. Use only supplied files/tests/model/effort. Declare dependencies. X serializes file conflicts and schedules at most two. No commands, writes, delegation or permissions.",
          }),
          files: [],
          tests: options.tests,
          outputSchema: schemas.plan,
          timeoutMs: options.timeoutMs ?? 180000,
          approve: options.approveTool,
          tool: async (evidence) => {
            primaryTools.push({ ...evidence, requestId });
            await save();
          },
        },
        signal,
        options.simulated === true,
      );
      const { output, ...metadata } = result;
      primary[primary.length - 1] = { ...entry, ...metadata };
      await save();
      if (result.status !== "completed")
        throw new WorkflowFailure(result.status);
      record.plan = validateOfficialPlan(
        output,
        options.models,
        options.files,
        options.tests,
        true,
      );
      record.dag!.nodes = record.plan.tasks.map((t) => ({
        id: t.id,
        state: "pending",
      }));
    }
    record.plan = validateOfficialPlan(
      record.plan,
      options.models,
      options.files,
      options.tests,
      true,
    );
    if (
      record.dag!.nodes.map((n) => n.id).join("|") !==
      record.plan.tasks.map((t) => t.id).join("|")
    )
      throw new WorkflowFailure("dag-nodes-changed");
    const approved = digest(record.plan);
    if (record.approvedDigest && record.approvedDigest !== approved)
      throw new WorkflowFailure("approval-digest-changed");
    if (!record.approvedDigest) {
      record.status = "approval";
      record.next = "approval";
      await save();
      if (
        !(await options.approve(structuredClone(record.plan), approved, signal))
      )
        throw new WorkflowFailure("plan-denied");
      await stable();
      signal.throwIfAborted();
      record.approvedDigest = approved;
      await save();
    }
    while (record.dag!.phase === "nodes") {
      signal.throwIfAborted();
      await stable();
      record.status = "implementing";
      record.next = "implement";
      // Complete retained results are imported first, never implemented again.
      for (const node of record.dag!.nodes.filter(
        (n) => n.state === "completed",
      )) {
        const task = record.plan.tasks.find((t) => t.id === node.id)!;
        node.state = "integrating";
        record.pendingEffect = { kind: "integrate", id: node.id };
        await save();
        record.head = await options.worktrees.integrate(
          node.cwd!,
          node.base!,
          node.record!.head,
          record.head,
          task.files,
          signal,
        );
        record.commits = await options.worktrees.history(
          record.base,
          record.head,
          signal,
        );
        node.integratedHead = record.head;
        node.state = "integrated";
        delete record.pendingEffect;
        await save();
      }
      if (record.dag!.nodes.every((n) => n.state === "integrated")) {
        record.dag!.phase = "integration";
        await save();
        break;
      }
      const ready = record
        .dag!.nodes.filter(
          (n) =>
            ["pending", "stopped", "running"].includes(n.state) &&
            record
              .plan!.tasks.find((t) => t.id === n.id)!
              .dependsOn.every(
                (id) =>
                  record.dag!.nodes.find((p) => p.id === id)!.state ===
                  "integrated",
              ),
        )
        .slice(0, 2);
      if (!ready.length) throw new WorkflowFailure("dag-no-ready-task");
      for (const node of ready) {
        const task = record.plan.tasks.find((t) => t.id === node.id)!;
        if (options.canStart && (await options.canStart(task, signal)) !== true)
          throw new WorkflowFailure("quota-paused");
      }
      // Worktree creation is serial and checkpointed before any native dispatch.
      for (const node of ready) {
        if (!node.cwd) {
          node.state = "creating";
          record.pendingEffect = { kind: "worktree", id: node.id };
          await save();
          node.cwd = await options.worktrees.create(record.head, signal);
          node.base = record.head;
          node.state = "pending";
          delete record.pendingEffect;
          await save();
        }
      }
      const wave = new AbortController(),
        waveSignal = AbortSignal.any([signal, wave.signal]);
      let stopped: string | undefined;
      const results = await Promise.allSettled(
        ready.map(async (node) => {
          try {
            const task = record.plan!.tasks.find((t) => t.id === node.id)!;
            const childOptions: WorkflowOptions = {
              ...options,
              cwd: node.cwd!,
              files: task.files,
              tests: options.tests.filter((t) =>
                task.acceptance.includes(t.id),
              ),
              integrationTests: [],
              workspace: await options.worktrees.open(node.cwd!, signal),
              resume: undefined,
              save: async (child) => {
                node.record = structuredClone(child);
                await save();
              },
              approve: async () => false,
            };
            const childPlan = {
              summary: task.instructions,
              tasks: [{ ...task, dependsOn: [] }],
            };
            if (
              node.record &&
              (digest(node.record.plan) !== digest(childPlan) ||
                node.record.approvedDigest !== digest(childPlan))
            )
              throw new WorkflowFailure("node-approval-changed");
            node.record ??= checkpoint(
              childOptions,
              node.base!,
              childPlan,
              record.id,
            );
            node.state = "running";
            await save();
            const child = await withTraceFields(
              { agentId: `${record.id}:${node.id}` },
              () =>
                runOfficialSingleTask(
                  { ...childOptions, resume: node.record },
                  waveSignal,
                ),
            );
            node.record = child;
            node.state = child.status === "completed" ? "completed" : "stopped";
            await save();
            if (child.status !== "completed") {
              stopped ??= child.error ?? child.status;
              wave.abort();
            }
          } catch (error) {
            wave.abort();
            throw error;
          }
        }),
      );
      if (results.some((r) => r.status === "rejected")) {
        wave.abort();
        throw new WorkflowFailure("dag-child-uncertain");
      }
      if (stopped) throw new WorkflowFailure(stopped);
    }
    await stable();
    record.status = "verifying";
    record.next = "verify";
    await verifyDagIntegration(options, record, signal, save);
    await stable();
    record.dag!.phase = "complete";
    record.status = "completed";
    record.next = "complete";
  } catch (error) {
    const code = signal.aborted
      ? "cancelled"
      : error instanceof WorkflowFailure
        ? error.code
        : "dag-invalid-or-unavailable";
    record.error = code;
    record.status =
      code === "quota-paused"
        ? "quota-paused"
        : code === "cancelled" || code === "plan-denied"
          ? "cancelled"
          : code.includes("attention")
            ? "attention"
            : "failed";
  }
  record.finishedAt = new Date().toISOString();
  await save();
  return structuredClone(record);
}
