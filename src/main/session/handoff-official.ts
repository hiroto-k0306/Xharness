import { lstat, realpath, readFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { Message } from "../core/types.js";
import type { HistoryScope } from "../tools/project-history.js";
import {
  approvalDigest,
  digest,
  type WorkflowRecord,
} from "../workflow/official/runtime.js";
import {
  nativeDecisionContract,
  independentlyPassed,
  validateNativeDecision,
} from "../workflow/official/native-dag.js";

async function completedNativeDag(
  record: WorkflowRecord,
  home: string,
  scope: HistoryScope,
) {
  try {
    const plan = nativeDecisionContract.parse(record.plan);
    validateNativeDecision(plan);
    const ordered = new Set<string>();
    while (ordered.size < plan.tasks.length) {
      const next = plan.tasks.find(
        (t) => !ordered.has(t.id) && t.dependsOn.every((id) => ordered.has(id)),
      );
      if (!next) return false;
      ordered.add(next.id);
    }
    const saved = record.nativeDagWorkspace,
      dag = record.dag;
    const hash = (value: unknown) =>
      typeof value === "string" &&
      /^[a-f0-9]{40,64}$/.test(value) &&
      !/^0+$/.test(value);
    const samePath = (a: string, b: string) =>
      resolve(a).toLowerCase() === resolve(b).toLowerCase();
    if (
      plan.parallelization.mode !== "parallel" ||
      !saved ||
      !dag ||
      dag.phase !== "complete" ||
      dag.maxParallel !== 2 ||
      dag.nativeConversationResume !== false ||
      !record.sourceCwd ||
      !samePath(record.sourceCwd, scope.cwd) ||
      !samePath(saved.source, scope.cwd) ||
      !hash(record.base) ||
      !hash(record.head) ||
      record.base !== saved.sourceBase ||
      record.head !== saved.integration?.head ||
      saved.integration.status !== "completed" ||
      record.approvedDigest !== approvalDigest(record) ||
      saved.approvalDigest !== record.approvedDigest ||
      !samePath(record.cwd, join(saved.ownedDirectory, "integration")) ||
      !samePath(saved.integration.cwd, record.cwd) ||
      !record.answer?.trim()
    )
      return false;
    const owner = join(home, "official-workflows", record.id, "parallel"),
      rel = relative(owner, saved.ownedDirectory);
    if (
      !rel ||
      isAbsolute(rel) ||
      rel.startsWith("..") ||
      rel.includes("/") ||
      rel.includes("\\") ||
      !rel.startsWith("project-dag-")
    )
      return false;
    for (const directory of [owner, saved.ownedDirectory, record.cwd]) {
      const stat = await lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        !samePath(await realpath(directory), directory)
      )
        return false;
    }
    const manifestPath = join(saved.ownedDirectory, "manifest.json"),
      stat = await lstat(manifestPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 2_000_000 ||
      !samePath(await realpath(manifestPath), manifestPath) ||
      digest(JSON.parse(await readFile(manifestPath, "utf8"))) !== digest(saved)
    )
      return false;
    if (
      dag.nodes.length !== plan.tasks.length ||
      saved.tasks.length !== plan.tasks.length ||
      new Set(dag.nodes.map((n) => n.id)).size !== plan.tasks.length
    )
      return false;
    for (const task of plan.tasks) {
      const node = dag.nodes.find((n) => n.id === task.id),
        workspace = saved.tasks.find((t) => t.id === task.id),
        child = node?.record;
      if (
        !node ||
        node.state !== "completed" ||
        !workspace ||
        workspace.status !== "completed" ||
        !hash(workspace.baseHead) ||
        !hash(workspace.commit) ||
        !record.commits.includes(workspace.commit!) ||
        !samePath(
          workspace.cwd,
          join(saved.ownedDirectory, `task-${task.id}`),
        ) ||
        !node.cwd ||
        !samePath(node.cwd, workspace.cwd) ||
        node.base !== workspace.baseHead ||
        digest(workspace.files) !== digest(task.files) ||
        digest(workspace.dependencies) !== digest(task.dependsOn) ||
        !child ||
        child.sessionId !== record.sessionId ||
        child.sourceCwd !== record.sourceCwd ||
        child.goal !== record.goal ||
        !hash(child.base) ||
        !hash(child.head) ||
        child.nativeWork?.validation !== "agent-reported" ||
        child.nativeWork.baseline !== "files" ||
        child.status !== "completed" ||
        child.next !== "complete" ||
        child.error ||
        child.pendingEffect ||
        !samePath(child.cwd, workspace.cwd) ||
        child.approvedDigest !== approvalDigest(child) ||
        child.plan?.tasks.length !== 1 ||
        digest(child.plan.tasks[0]) !== digest(task) ||
        !task.reviewer ||
        task.reviewer.provider === task.assignee.provider
      )
        return false;
      const calls = record.calls
        .filter((c) => c.nodeId === task.id)
        .map((call) => {
          const copy = { ...call };
          delete copy.nodeId;
          return copy;
        });
      if (
        digest(calls) !== digest(child.calls) ||
        !child.calls.some(
          (c) =>
            c.phase === "implement" &&
            c.provider === task.assignee.provider &&
            c.status === "completed" &&
            c.dispatched === true,
        ) ||
        !child.calls.some(
          (c) =>
            c.phase === "review" &&
            c.provider === task.reviewer!.provider &&
            c.status === "completed" &&
            c.dispatched === true,
        )
      )
        return false;
      const review = child.reviews.findLast(
        (r) => r.base === child.base && r.head === child.head,
      );
      if (!review || review.findings.some((f) => f.severity !== "nit"))
        return false;
      const childReviewCall = child.calls.findLast(
        (c) => c.phase === "review" && c.provider === task.reviewer!.provider,
      );
      if (
        !childReviewCall?.communication?.output ||
        childReviewCall.communication.boundary !== "xharness-official-agent" ||
        childReviewCall.communication.output.truncated ||
        digest(
          reviewContract.parse(
            JSON.parse(childReviewCall.communication.output.text),
          ),
        ) !== digest(reviewContract.parse(review))
      )
        return false;
    }
    const check = record.checks.findLast((c) => c.head === record.head);
    if (
      !check?.tests.length ||
      !check.tests.every(
        (t) =>
          t.id === "native-dag-node-validation" &&
          t.source === "process" &&
          t.passed &&
          t.exitCode === 0 &&
          independentlyPassed(t.output),
      )
    )
      return false;
    for (const provider of new Set(
      plan.tasks.map((t) => t.reviewer!.provider),
    )) {
      const call = record.calls.findLast(
        (c) => !c.nodeId && c.phase === "review" && c.provider === provider,
      );
      if (
        !call ||
        call.status !== "completed" ||
        call.dispatched !== true ||
        !call.communication?.output ||
        call.communication.boundary !== "xharness-official-agent" ||
        call.communication.output.truncated
      )
        return false;
      const output = reviewContract.parse(
        JSON.parse(call.communication.output.text),
      );
      if (
        !record.reviews.some(
          (r) =>
            digest(reviewContract.parse(r)) === digest(output) &&
            r.base === record.base &&
            r.head === record.head &&
            r.findings.every((f) => f.severity === "nit"),
        )
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

import { reviewContract } from "../workflow/official/contracts.js";
import { officialSessionSummary } from "../workflow/official/session-result.js";
import { readReceiptReplay } from "./replay.js";

/** Passive evidence only. Does not instantiate a service, provider, SDK or CLI. */
export async function officialHandoffSource(
  scope: HistoryScope,
  home: string,
  messages: Message[],
) {
  const last = messages.at(-1);
  const replay = await readReceiptReplay(home, scope.sessionId, {
    clean: scope.clean,
  });
  const receipt = replay.frames.findLast(
    (f) =>
      f.receipt.kind === "model_call" || f.receipt.tool === "OfficialWorkflow",
  )?.receipt;
  const marker = last?.meta?.officialWorkflow;
  if (!marker && receipt?.tool !== "OfficialWorkflow") return;
  const id = (receipt?.input as { workflowId?: unknown })?.workflowId;
  const reject = (): never => {
    throw new Error("公式workflowの確定結果と最終回答を確認できません。");
  };
  if (
    replay.skipped ||
    receipt?.tool !== "OfficialWorkflow" ||
    typeof id !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id) ||
    (marker &&
      (marker.id !== id ||
        marker.status !== "completed" ||
        marker.taskRequired))
  )
    reject();
  const path = join(home, "official-workflows", id as string, "workflow.json");
  let record: WorkflowRecord;
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 2_000_000 ||
      (await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()
    )
      reject();
    record = JSON.parse(await readFile(path, "utf8")) as WorkflowRecord;
  } catch {
    return reject();
  }
  if (
    record.version !== 1 ||
    record.id !== id ||
    record.sessionId !== scope.sessionId ||
    record.status !== "completed" ||
    record.next !== "complete" ||
    record.pendingEffect ||
    record.error ||
    record.inputIntent === "work" ||
    typeof record.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(record.finishedAt)) ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt)) ||
    Date.parse(record.finishedAt) < Date.parse(record.startedAt) ||
    !Array.isArray(record.calls) ||
    !record.calls.length ||
    record.calls.some((c) => c.status !== "completed") ||
    messages
      .findLast((m) => m.role === "user")
      ?.content.filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n") !== scope.clean(record.goal) ||
    last?.role !== "assistant" ||
    last.content.some((b) => b.type !== "text") ||
    last.content.map((b) => (b.type === "text" ? b.text : "")).join("\n") !==
      scope.clean(
        officialSessionSummary(record, !!record.project || !!record.nativeWork),
      )
  )
    reject();
  if (record.project || record.nativeWork) {
    if (
      typeof record.cwd !== "string" ||
      (record.nativeWork?.validation !== "independent-process" &&
        resolve(record.cwd).toLowerCase() !==
          resolve(scope.cwd).toLowerCase()) ||
      !/^[a-f0-9]{64}$/.test(record.approvedDigest ?? "") ||
      !Array.isArray(record.checks) ||
      !Array.isArray(record.reviews)
    )
      reject();
    const check = record.checks.findLast((c) => c.head === record.head);
    const review = record.reviews.findLast(
      (r) => r.head === record.head && r.base === record.base,
    );
    const validated = record.nativeWork
      ? record.nativeWork.validation === "independent-process"
        ? await completedNativeDag(record, home, scope)
        : record.nativeWork.validation === "agent-reported" &&
          record.nativeWork.baseline === "files" &&
          Array.isArray(record.nativeValidation) &&
          record.nativeValidation.every((t) =>
            ["passed", "not-run"].includes(t.status),
          ) &&
          typeof record.answer === "string" &&
          !!record.answer.trim()
      : !!check?.tests.length &&
        check.tests.every(
          (t) => t.passed && t.exitCode === 0 && t.source === "process",
        );
    if (
      !validated ||
      !review ||
      !Array.isArray(review.findings) ||
      review.findings.some((f) => f.severity !== "nit")
    )
      reject();
  } else if (typeof record.answer !== "string" || !record.answer.trim())
    reject();
  return {
    taskId: record.id,
    completedAt: record.finishedAt!,
    evidence: {
      record,
      replay,
      ...(record.nativeDagWorkspace
        ? {
            validation: {
              basis: "saved-completion-snapshots",
              sourceBase: record.nativeDagWorkspace.sourceBase,
              integrationHead: record.nativeDagWorkspace.integration?.head,
              currentSourceHeadVerified: false,
            },
          }
        : {}),
    },
  };
}
