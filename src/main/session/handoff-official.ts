import { lstat, realpath, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Message } from "../core/types.js";
import type { HistoryScope } from "../tools/project-history.js";
import type { WorkflowRecord } from "../workflow/official/runtime.js";
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
      resolve(record.cwd).toLowerCase() !== resolve(scope.cwd).toLowerCase() ||
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
      ? record.nativeWork.validation === "agent-reported" &&
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
    evidence: { record, replay },
  };
}
