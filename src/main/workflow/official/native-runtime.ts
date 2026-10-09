import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  nativeSnapshot,
  nativeDiff,
  type NativeSnapshot,
} from "./native-snapshot.js";
import {
  approvalDigest,
  digest,
  type WorkflowOptions,
  type WorkflowRecord,
} from "./runtime.js";
import {
  planContract,
  reviewContract,
  validateOfficialPlan,
  WorkflowFailure,
  type AgentRequest,
  type ModelCandidate,
} from "./contracts.js";
import { communicationInput, communicationText } from "./communication.js";
import { publicEventRecorder } from "./public-events.js";
import { beginTrace, withTraceFields } from "../../core/trace.js";

const resultContract = z
  .object({
    summary: z.string().min(1).max(4000),
    tests: z
      .array(
        z
          .object({
            command: z.string().max(4000),
            status: z.enum(["passed", "failed", "not-run"]),
            summary: z.string().max(4000),
          })
          .strict(),
      )
      .max(30),
  })
  .strict();
/** Normal native work, separate from fixed offline evaluation/registered tests. */
export async function runNativeTask(
  options: WorkflowOptions,
  signal: AbortSignal,
): Promise<WorkflowRecord> {
  if (options.resume)
    throw new WorkflowFailure("native-work-resume-not-supported");
  let baseline: NativeSnapshot;
  const record: WorkflowRecord = {
    version: 1,
    id: options.id ?? randomUUID(),
    sessionId: options.sessionId,
    sourceCwd: options.cwd,
    cwd: options.cwd,
    goal: options.goal,
    simulated: options.simulated === true,
    startedAt: new Date().toISOString(),
    status: "planning",
    next: "plan",
    base: "0".repeat(64),
    head: "0".repeat(64),
    correctionRounds: 0,
    calls: structuredClone(options.preparationCalls ?? []),
    tools: [],
    checks: [],
    reviews: [],
    commits: [],
    nativeWork: { validation: "agent-reported", baseline: "files" },
    executionDigest: digest({
      cwd: options.cwd,
      goal: options.goal,
      mode: "native-v1",
    }),
  };
  let tail = Promise.resolve();
  const save = () => {
    const copy = structuredClone(record);
    const pending = tail.then(() => options.save(copy));
    tail = pending;
    return pending;
  };
  const eligible = (
    provider: "claude" | "codex",
    model: string,
    effort: AgentRequest["effort"],
  ) => {
    const candidate = options.models.find(
      (m) =>
        m.provider === provider &&
        m.model === model &&
        m.available &&
        m.quotaAllowed === true &&
        m.efforts.includes(effort),
    );
    if (!candidate) throw new WorkflowFailure("unavailable-model");
    return candidate;
  };
  async function invoke(
    phase: AgentRequest["phase"],
    model: ModelCandidate,
    effort: AgentRequest["effort"],
    prompt: unknown,
    schema: Record<string, unknown>,
  ) {
    signal.throwIfAborted();
    if (record.calls.filter((c) => c.phase !== "conversation").length >= 7)
      throw new WorkflowFailure("call-budget-exceeded");
    const requestId = randomUUID(),
      communication = communicationInput({
        prompt,
        files: [],
        tests: [],
        outputSchema: schema,
      });
    const index = record.calls.length;
    record.calls.push({
      requestId,
      phase,
      provider: model.provider,
      requestedModel: model.model,
      effort,
      status: "running",
      communication,
    });
    const observe = publicEventRecorder(communication);
    await save();
    const span = beginTrace(
      "llm",
      model.provider,
      { officialPhase: phase, requestId, internal: { model: model.model } },
      options.simulated,
    );
    const result = await withTraceFields(span.fields, () =>
      options.agents[model.provider].run(
        {
          nativeWork: true,
          requestId,
          taskId: record.id,
          phase,
          cwd: options.cwd,
          model,
          effort,
          files: [],
          tests: [],
          prompt: JSON.stringify(prompt),
          outputSchema: schema,
          timeoutMs: options.timeoutMs ?? 120000,
          diagnosticText: false,
          approve: options.approveTool,
          event: async (event) => {
            if (observe(event)) await save();
          },
          tool: async (evidence) => {
            if (record.tools.length >= 1000)
              throw new WorkflowFailure("tool-evidence-limit");
            record.tools.push({ ...evidence, requestId });
            await save();
          },
        },
        signal,
      ),
    );
    const { output, ...metadata } = result;
    record.calls[index] = {
      requestId,
      phase,
      provider: model.provider,
      requestedModel: model.model,
      effort,
      ...metadata,
      communication: {
        ...communication,
        ...(output !== undefined ? { output: communicationText(output) } : {}),
      },
    };
    span.end(
      {
        dispatched: result.dispatched,
        usageComplete: result.usage?.complete ?? false,
      },
      result.status,
    );
    await save();
    if (result.status !== "completed")
      throw new WorkflowFailure(result.error ?? result.status);
    return output;
  }
  const schema = (contract: z.ZodType) =>
    z.toJSONSchema(contract, { target: "draft-7" });
  try {
    baseline = await nativeSnapshot(options.cwd, signal);
    record.base = record.head = baseline.head;
    record.executionDigest = digest({
      cwd: options.cwd,
      goal: options.goal,
      baseline: baseline.head,
      mode: "native-v1",
    });
    const selection = options.planner;
    if (!selection) throw new WorkflowFailure("planner-missing");
    const provider = "provider" in selection ? selection.provider : "claude";
    record.planner = { ...selection, provider };
    const planner = eligible(provider, selection.model, selection.effort);
    await save();
    const proposed = planContract.parse(
      await invoke(
        "plan",
        planner,
        selection.effort,
        {
          goal: options.goal,
          cwd: options.cwd,
          availableModels: options.models,
          instruction:
            "Explore this workspace read-only using native tools. Return one task with Japanese summary, instructions, proposed files and acceptance criteria (plain text, not registered IDs). Select an implementer and a reviewer from different companies using availableModels. Existing tests are not required: choose suitable validation, or explicitly explain what cannot be tested. Do not edit or run project code until user approves the plan. Do not access credentials or delegate.",
        },
        schema(planContract),
      ),
    );
    // Scope is the workspace, not an enumerated preflight list. Still validate
    // model assignments, safe relative hints and the cross-company reviewer.
    record.plan = validateOfficialPlan(
      proposed,
      options.models,
      proposed.tasks.flatMap((t) => t.files),
      proposed.tasks
        .flatMap((t) => t.acceptance)
        .map((id) => ({
          id,
          program: "",
          args: [],
          command: "",
          timeoutMs: 0,
        })),
      false,
      true,
    );
    if (record.plan.tasks.length !== 1)
      throw new WorkflowFailure("multi-task-not-enabled");
    const task = record.plan.tasks[0]!;
    const implementer = eligible(
      task.assignee.provider,
      task.assignee.model,
      task.assignee.effort,
    );
    const reviewer = eligible(
      task.reviewer!.provider,
      task.reviewer!.model,
      task.reviewer!.effort,
    );
    if ((await nativeSnapshot(options.cwd, signal)).head !== baseline.head)
      throw new WorkflowFailure("workspace-changed-before-approval");
    record.status = "approval";
    record.next = "approval";
    await save();
    const approved = approvalDigest(record);
    if (
      !(await options.approve(structuredClone(record.plan), approved, signal))
    )
      throw new WorkflowFailure("plan-denied");
    signal.throwIfAborted();
    if ((await nativeSnapshot(options.cwd, signal)).head !== baseline.head)
      throw new WorkflowFailure("workspace-changed-before-approval");
    record.approvedDigest = approved;
    for (let round = 0; round <= 2; round++) {
      record.correctionRounds = round;
      record.status = "implementing";
      record.next = round ? "fix" : "implement";
      await save();
      const output = resultContract.parse(
        await invoke(
          round ? "fix" : "implement",
          implementer,
          task.assignee.effort,
          {
            goal: options.goal,
            plan: record.plan,
            review: record.reviews.at(-1),
            cwd: options.cwd,
            instruction:
              "Implement the approved goal using native exploration/editing/testing tools in this workspace. Preserve preexisting unrelated changes. You may choose tests or add tests; run suitable validation. Request user approval where needed. Do not commit, reset, discard changes, access credentials, enable paid APIs or delegate. Return summary and each actual validation command/status. Never invent passing tests; report unavailable tests as not-run.",
          },
          schema(resultContract),
        ),
      );
      record.nativeValidation = output.tests;
      const after = await nativeSnapshot(options.cwd, signal),
        full = nativeDiff(baseline, after);
      record.head = after.head;
      if (!full.files.length) throw new WorkflowFailure("no-changes");
      record.status = "reviewing";
      record.next = "review";
      await save();
      const review = reviewContract.parse(
        await invoke(
          "review",
          reviewer,
          task.reviewer!.effort,
          {
            goal: options.goal,
            plan: record.plan,
            base: record.base,
            head: record.head,
            changes: full.diff,
            validation: { source: "agent-reported", tests: output.tests },
            instruction:
              "Read-only independent cross-company review of these fixed before/after file contents. Baseline includes preexisting user edits; hashes are file snapshots, not Git commits. Model-reported tests are not independent process verification. Return matching base/head and concrete findings. No writes, project code execution or credentials.",
          },
          schema(reviewContract),
        ),
      );
      if (
        (await nativeSnapshot(options.cwd, signal)).head !== after.head ||
        review.base !== record.base ||
        review.head !== record.head ||
        review.findings.some((f) => !full.files.includes(f.file))
      )
        throw new WorkflowFailure("review-snapshot-mismatch");
      record.reviews.push(review);
      const blocking =
        output.tests.some((t) => t.status === "failed") ||
        review.findings.some((f) => f.severity !== "nit");
      if (!blocking) {
        record.status = "completed";
        record.next = "complete";
        record.answer = `${output.summary}\n検証：公式エージェントの実行報告（ハーネス独立検証ではありません）。${output.tests.length ? output.tests.map((t) => `${t.command}: ${t.status}`).join(" / ") : "テスト実行報告なし"}。別会社レビュー完了。`;
        break;
      }
      if (round === 2) {
        record.status = "attention";
        record.next = "complete";
      }
    }
  } catch (error) {
    record.status = signal.aborted ? "cancelled" : "failed";
    record.error =
      error instanceof WorkflowFailure
        ? error.code
        : error instanceof z.ZodError
          ? `${record.next}-invalid-output`
          : "native-work-invalid-or-unavailable";
    record.next = "complete";
  }
  record.finishedAt = new Date().toISOString();
  await save();
  await tail;
  return record;
}
