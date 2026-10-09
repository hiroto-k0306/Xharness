import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  planContract,
  reviewContract,
  WorkflowFailure,
  type TestSpec,
  type TestEvidence,
} from "./contracts.js";
import {
  approvalDigest,
  digest,
  type WorkflowOptions,
  type WorkflowRecord,
} from "./runtime.js";
import { runNativeTask } from "./native-runtime.js";
import { nativeSnapshot } from "./native-snapshot.js";
import { harnessTestCommand } from "./operation-approval.js";
import { projectNode } from "./project-task.js";
import { scopedPath } from "./workspace.js";
import { lstat } from "node:fs/promises";
import { resolveCallSelection, policyCandidate } from "./model-selection.js";
import {
  resolveCallSkills,
  skillEvidence,
  skillSelections,
} from "./skill-selection.js";
import { communicationInput, communicationText } from "./communication.js";
import { publicEventRecorder } from "./public-events.js";
import type { createProjectDagWorkspace } from "./project-dag-workspace.js";

export type NativeDagWorkspace = Awaited<
  ReturnType<typeof createProjectDagWorkspace>
>;
export interface NativeDagOptions extends WorkflowOptions {
  /** Fixed diagnostic from the runtime gate; never raw CLI output. */
  validationUnavailableReason?: string;
  /** Invalidate a previously proven runtime before approved side effects. */
  checkValidationRuntime?: (signal: AbortSignal) => Promise<void>;
  validateIntegration?: (
    spec: TestSpec,
    cwd: string,
    signal: AbortSignal,
  ) => Promise<TestEvidence>;
  prepareDag(
    approvalDigest: string,
    signal: AbortSignal,
  ): Promise<NativeDagWorkspace>;
}
export const nativeDecisionContract = planContract.extend({
  parallelization: planContract.shape.parallelization.unwrap(),
});
const decisionInstruction =
  "Explore read-only. Every work plan must decide serial or parallel and explain why, including actual known resources, coordination costs and unresolved conditions; never invent timing/speed estimates. Serial: exactly one combined task, maxParallel 1. Parallel only for a clean Git repository including untracked files; user branch is unchanged and owned integration workspaces retained. Parallel: 2..16 acyclic tasks, maxParallel 2, disjoint paths between independent tasks, exact files and dependencies, cross-company reviewer for each. Each task chooses an available provider:alias and independent effort with reasons. Parallel requires validation.testFiles: exact .test.js or .test.mjs paths included in task files, run by harness Node --test after integration and separate explicit code execution approval. Other frameworks/languages are not independently supported in this initial parallel path; choose serial when unsupported. Do not edit/run code/delegate/access credentials before approval.";

export function validateNativeDecision(
  plan: z.infer<typeof nativeDecisionContract>,
) {
  const p = plan.parallelization;
  if (p.mode === "parallel" && p.unresolved?.length)
    throw new WorkflowFailure("parallelization-unresolved");
  if (p.mode === "serial") {
    if (
      p.maxParallel !== 1 ||
      plan.tasks.length !== 1 ||
      plan.tasks[0]!.dependsOn.length
    )
      throw new WorkflowFailure("serial-requires-one-combined-task");
  } else {
    if (p.maxParallel !== 2 || plan.tasks.length < 2)
      throw new WorkflowFailure("parallel-requires-multiple-tasks");
    const files = new Set(plan.tasks.flatMap((t) => t.files));
    if (
      !plan.validation ||
      plan.validation.testFiles.some(
        (f) =>
          !/^[A-Za-z0-9_./-]+\.test\.(mjs|js)$/.test(f) ||
          f.startsWith("-") ||
          !files.has(f),
      ) ||
      new Set(plan.validation.testFiles).size !==
        plan.validation.testFiles.length
    )
      throw new WorkflowFailure("needs-independent-validation");
  }
}
/** No shell or model-selected executable/flags. Tests can contain arbitrary code and require separate approval. */
export async function approvedNodeValidation(
  cwd: string,
  source: string,
  testFiles: string[],
): Promise<TestSpec> {
  for (const file of testFiles) {
    const stat = await lstat(await scopedPath(cwd, file));
    if (!stat.isFile() || stat.nlink !== 1)
      throw new WorkflowFailure("independent-test-file-unsafe");
  }
  const program = process.versions.electron
    ? await projectNode(cwd, process.env.PATH ?? "", source)
    : process.execPath;
  return {
    id: "native-dag-node-validation",
    program,
    args: ["--test", "--test-reporter=tap", ...testFiles],
    command: harnessTestCommand(program, [
      "--test",
      "--test-reporter=tap",
      ...testFiles,
    ]),
    timeoutMs: 60000,
  };
}
const count = z.number().int().min(0).max(1000000);
const independentEvidenceContract = z
  .object({
    mechanism: z.literal("official-command-exec"),
    status: z.enum(["passed", "failed-or-unconfirmed"]),
    counts: z
      .object({
        tests: count,
        pass: count,
        fail: count,
        cancelled: count,
        skipped: count,
        todo: count,
      })
      .strict()
      .nullable(),
    outputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export function independentlyPassed(output: string) {
  try {
    const evidence = independentEvidenceContract.parse(JSON.parse(output));
    const c = evidence.counts;
    return (
      evidence.status === "passed" &&
      !!c &&
      c.tests > 0 &&
      c.pass > 0 &&
      c.fail === 0 &&
      c.cancelled === 0 &&
      c.todo === 0 &&
      c.tests === c.pass + c.fail + c.cancelled + c.skipped + c.todo
    );
  } catch {
    return false;
  }
}
/** Read-only decision once, then ordinary serial execution or isolated, bounded parallel execution. No resume/replay. */
export async function runNativePlannedWork(
  options: NativeDagOptions,
  signal: AbortSignal,
): Promise<WorkflowRecord> {
  const baseline = await nativeSnapshot(options.cwd, signal);
  const record = await runNativeTask(
    {
      ...options,
      nativePlanningOnly: true,
      nativePlanSchema: z.toJSONSchema(nativeDecisionContract, {
        target: "draft-7",
      }),
      nativePlanInstruction: `${decisionInstruction} Harness independent validation diagnostic: ${/^[a-z0-9-]{1,80}$/.test(options.validationUnavailableReason ?? "") ? options.validationUnavailableReason : "unverified"}. Harness independent validation availability: ${options.validateIntegration ? "an explicit validator is configured; OS isolation verification is its own contract, never infer it from agent output" : "unavailable in this runtime; consider parallelization but propose serial with this constraint as a reason. A parallel plan will stop before approval and implementation"}.`,
    },
    signal,
  );
  if (
    !record.plan ||
    record.status === "failed" ||
    record.status === "cancelled"
  )
    return record;
  let tail = Promise.resolve();
  const save = () => {
    const copy = structuredClone(record);
    return (tail = tail.then(() => options.save(copy)));
  };
  let workspace: NativeDagWorkspace | undefined;
  const running = new Map<string, Promise<void>>();
  const stop = new AbortController();
  const onAbort = () => stop.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    const plan = nativeDecisionContract.parse(record.plan);
    validateNativeDecision(plan);
    if (plan.parallelization.mode === "serial") {
      return await runNativeTask(
        { ...options, preparedNative: { record, baseline } },
        signal,
      );
    }
    if (!options.validateIntegration)
      throw new WorkflowFailure("independent-validation-unavailable");
    await options.checkValidationRuntime?.(stop.signal);
    if ((await nativeSnapshot(options.cwd, signal)).head !== baseline.head)
      throw new WorkflowFailure("workspace-changed-before-approval");
    record.status = "approval";
    record.next = "approval";
    await save();
    const approved = approvalDigest(record);
    if (!(await options.approve(structuredClone(plan), approved, signal)))
      throw new WorkflowFailure("plan-denied");
    if (
      approvalDigest(record) !== approved ||
      (await nativeSnapshot(options.cwd, signal)).head !== baseline.head
    )
      throw new WorkflowFailure("workspace-changed-before-approval");
    await options.checkValidationRuntime?.(stop.signal);
    record.approvedDigest = approved;
    record.pendingEffect = { kind: "worktree", id: randomUUID() };
    await save();
    workspace = await options.prepareDag(approved, stop.signal);
    record.nativeDagWorkspace = workspace.snapshots();
    delete record.pendingEffect;
    record.dag = {
      maxParallel: 2,
      phase: "nodes",
      nodes: plan.tasks.map((t) => ({ id: t.id, state: "pending" })),
      nativeConversationResume: false,
    };
    await save();
    const assertApproved = () => {
      if (approvalDigest(record) !== approved)
        throw new WorkflowFailure("approved-plan-changed");
      stop.signal.throwIfAborted();
    };
    const runNode = async (id: string) => {
      assertApproved();
      await options.checkValidationRuntime?.(stop.signal);
      assertApproved();
      const task = plan.tasks.find((t) => t.id === id)!;
      const node = record.dag!.nodes.find((n) => n.id === id)!;
      node.state = "creating";
      await save();
      const owned = await workspace!.task(
        id,
        task.dependsOn,
        task.files,
        stop.signal,
      );
      node.cwd = owned.cwd;
      node.base = owned.baseHead;
      record.nativeDagWorkspace = workspace!.snapshots();
      await save();
      const initial = await nativeSnapshot(owned.cwd, stop.signal);
      const child: WorkflowRecord = {
        ...structuredClone(record),
        id: randomUUID(),
        cwd: owned.cwd,
        base: initial.head,
        head: initial.head,
        plan: { summary: plan.summary, tasks: [structuredClone(task)] },
        calls: [],
        tools: [],
        checks: [],
        reviews: [],
        commits: [],
        status: "implementing",
        next: "implement",
      };
      delete child.dag;
      delete child.nativeDagWorkspace;
      delete child.pendingEffect;
      child.approvedDigest = approvalDigest(child);
      node.state = "running";
      const saveChild = async (copy: WorkflowRecord) => {
        node.record = copy;
        record.calls = [
          ...record.calls.filter((c) => c.nodeId !== id),
          ...copy.calls.map((c) => ({ ...c, nodeId: id })),
        ];
        await save();
      };
      const result = await runNativeTask(
        {
          ...options,
          cwd: owned.cwd,
          save: saveChild,
          preparedNative: {
            record: child,
            baseline: initial,
            approved: true,
            writeScope: [...task.files],
          },
        },
        stop.signal,
      );
      node.record = result;
      if (result.status !== "completed") {
        node.state = "stopped";
        throw new WorkflowFailure(
          result.error ?? "native-dag-node-not-completed",
        );
      }
      assertApproved();
      record.pendingEffect = { kind: "commit", id };
      await save();
      const head = await owned.commit({
        approvalDigest: approved,
        signal: stop.signal,
      });
      record.commits.push(head);
      delete record.pendingEffect;
      node.state = "completed";
      record.nativeDagWorkspace = workspace!.snapshots();
      await save();
    };
    let failure: unknown;
    while (record.dag.nodes.some((n) => n.state !== "completed")) {
      assertApproved();
      for (const task of plan.tasks) {
        if (running.size >= 2) break;
        const node = record.dag.nodes.find((n) => n.id === task.id)!;
        if (
          node.state !== "pending" ||
          !task.dependsOn.every(
            (id) =>
              record.dag!.nodes.find((n) => n.id === id)?.state === "completed",
          )
        )
          continue;
        node.state = "creating";
        const promise = runNode(task.id)
          .catch((error) => {
            failure ??= error;
            stop.abort(error);
          })
          .finally(() => running.delete(task.id));
        running.set(task.id, promise);
      }
      if (!running.size) throw new WorkflowFailure("native-dag-no-ready-task");
      await Promise.race(running.values());
      if (failure) {
        await Promise.allSettled(running.values());
        throw failure;
      }
    }
    await Promise.allSettled(running.values());
    if (failure) throw failure;
    assertApproved();
    const ordered: string[] = [];
    while (ordered.length < plan.tasks.length) {
      const next = plan.tasks.find(
        (t) =>
          !ordered.includes(t.id) &&
          t.dependsOn.every((id) => ordered.includes(id)),
      );
      if (!next) throw new WorkflowFailure("native-dag-cycle");
      ordered.push(next.id);
    }
    record.dag.phase = "integration";
    record.pendingEffect = { kind: "integrate", id: randomUUID() };
    await save();
    const integrated = await workspace.integrate(ordered, {
      approvalDigest: approved,
      signal: stop.signal,
    });
    delete record.pendingEffect;
    record.cwd = integrated.cwd;
    record.base = workspace.sourceBase;
    record.head = integrated.head;
    record.nativeDagWorkspace = workspace.snapshots();
    await save();
    const spec = await approvedNodeValidation(
      integrated.cwd,
      options.cwd,
      plan.validation!.testFiles,
    );
    const testBaseline = await nativeSnapshot(integrated.cwd, stop.signal);
    record.status = "verifying";
    record.next = "verify";
    record.pendingEffect = { kind: "test", id: randomUUID() };
    await save();
    const requestId = randomUUID();
    const allowed = await options.approveTool(
      "harness/test",
      {
        workflowId: record.id,
        requestId,
        digest: digest({ spec, head: record.head, content: testBaseline.head }),
        cwd: integrated.cwd,
        testFiles: plan.validation!.testFiles,
        command: spec.command,
        program: spec.program,
        args: spec.args,
        reason:
          "統合作業場所で承認済み Node テストをハーネスが独立実行します。テストコードの実行を許可してください。",
      },
      stop.signal,
    );
    if (allowed !== true) throw new WorkflowFailure("independent-test-denied");
    assertApproved();
    if (
      (await nativeSnapshot(integrated.cwd, stop.signal)).head !==
      testBaseline.head
    )
      throw new WorkflowFailure("independent-test-snapshot-changed");
    if (!options.validateIntegration)
      throw new WorkflowFailure("independent-validation-unavailable");
    const evidence = await options.validateIntegration(
      spec,
      integrated.cwd,
      stop.signal,
    );
    record.checks.push({ head: record.head, tests: [evidence] });
    delete record.pendingEffect;
    await save();
    if (
      evidence.exitCode !== 0 ||
      !evidence.passed ||
      !independentlyPassed(evidence.output)
    )
      throw new WorkflowFailure("independent-validation-failed");
    if (
      (await nativeSnapshot(integrated.cwd, stop.signal)).head !==
        testBaseline.head ||
      (await integrated.workspace.inspect(stop.signal)).head !== record.head
    )
      throw new WorkflowFailure("independent-test-mutated-workspace");
    const full = await integrated.workspace.snapshot(
      record.base,
      record.head,
      stop.signal,
    );
    // A mixed-company DAG receives both company reviews, each independent of that company's counterpart implementers.
    for (const provider of new Set(
      plan.tasks.map((t) => t.reviewer!.provider),
    )) {
      assertApproved();
      const task = plan.tasks.find((t) => t.reviewer!.provider === provider)!;
      const choice = task.reviewer!;
      const candidate = await policyCandidate(
        options,
        record,
        provider,
        choice.model,
        choice.effort,
        stop.signal,
      );
      if (!candidate) throw new WorkflowFailure("unavailable-model");
      const selection = await resolveCallSelection(
        options,
        { ...record, plan: { summary: plan.summary, tasks: [task] } },
        "review",
        candidate,
        choice.effort,
        stop.signal,
      );
      const skills = await resolveCallSkills(
        { ...options, nativeWork: true },
        record,
        provider,
        "review",
        stop.signal,
      );
      const prompt = {
        goal: record.goal,
        plan,
        base: record.base,
        head: record.head,
        changes: full.diff,
        validation: record.checks,
        instruction:
          "Read-only overall cross-company integration review. Independent process evidence is separate from agent reports. No writes or code execution. Return exact base/head and findings.",
      };
      const outputSchema = z.toJSONSchema(reviewContract, {
        target: "draft-7",
      });
      const communication = communicationInput({
        prompt,
        files: full.files,
        tests: [spec],
        outputSchema,
      });
      const observe = publicEventRecorder(communication);
      const requestId = randomUUID(),
        index = record.calls.length;
      record.status = "reviewing";
      record.next = "review";
      record.calls.push({
        requestId,
        phase: "review",
        provider,
        requestedModel: selection.model.model,
        effort: selection.effort,
        status: "running",
        ...(skills.length
          ? { officialSkills: { requested: skillSelections(skills) } }
          : {}),
        communication,
        ...(selection.modelSelection
          ? { modelSelection: selection.modelSelection }
          : {}),
      });
      await save();
      const result = await options.agents[provider].run(
        {
          nativeWork: true,
          requestId,
          taskId: record.id,
          phase: "review",
          cwd: integrated.cwd,
          model: selection.model,
          effort: selection.effort,
          files: full.files,
          tests: [spec],
          prompt: JSON.stringify(prompt),
          outputSchema,
          timeoutMs: options.timeoutMs ?? 120000,
          approve: options.approveTool,
          ...(skills.length ? { officialSkills: skills } : {}),
          event: async (e) => {
            if (observe(e)) await save();
          },
          tool: async (e) => {
            if (record.tools.length >= 1000)
              throw new WorkflowFailure("tool-evidence-limit");
            record.tools.push({ ...e, requestId });
            await save();
          },
        },
        stop.signal,
      );
      const { output, officialSkillsEvidence, ...metadata } = result;
      record.calls[index] = {
        requestId,
        phase: "review",
        provider,
        requestedModel: selection.model.model,
        effort: selection.effort,
        ...metadata,
        communication: { ...communication, output: communicationText(output) },
        ...(selection.modelSelection
          ? { modelSelection: selection.modelSelection }
          : {}),
        ...(skills.length
          ? { officialSkills: skillEvidence(skills, officialSkillsEvidence) }
          : {}),
      };
      await save();
      if (result.status !== "completed")
        throw new WorkflowFailure(result.error ?? result.status);
      const review = reviewContract.parse(output);
      record.reviews.push(review);
      if (
        review.base !== record.base ||
        review.head !== record.head ||
        review.findings.some((f) => !full.files.includes(f.file)) ||
        (await nativeSnapshot(integrated.cwd, stop.signal)).head !==
          testBaseline.head ||
        (await integrated.workspace.inspect(stop.signal)).head !== record.head
      )
        throw new WorkflowFailure("review-snapshot-mismatch");
      if (review.findings.some((f) => f.severity !== "nit"))
        throw new WorkflowFailure("integration-review-blocking");
    }
    record.nativeWork = {
      validation: "independent-process",
      baseline: "files",
    };
    record.dag.phase = "complete";
    record.status = "completed";
    record.next = "complete";
    record.answer =
      "隔離作業場所で実装・別会社レビュー・統合を完了し、承認済み Node テストの独立実行が成功しました。利用者のブランチは変更していません。";
  } catch (error) {
    stop.abort(error);
    await Promise.allSettled(running.values());
    if (workspace) record.nativeDagWorkspace = workspace.snapshots();
    record.status = signal.aborted ? "cancelled" : "attention";
    record.next = "complete";
    record.error =
      error instanceof WorkflowFailure
        ? error.code
        : error instanceof z.ZodError
          ? "parallelization-invalid-output"
          : "native-dag-invalid-or-unavailable";
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  record.finishedAt = new Date().toISOString();
  await save();
  return record;
}
