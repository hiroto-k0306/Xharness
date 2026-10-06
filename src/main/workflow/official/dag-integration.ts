import { randomUUID } from "node:crypto";
import { runOfficialSingleTask, type WorkflowRecord } from "./runtime.js";
import {
  WorkflowFailure,
  reviewContract,
  schemas,
  type OfficialPlan,
  type AgentRequest,
} from "./contracts.js";
import { checkpoint, type DagOptions } from "./dag.js";
import { runDagAgent } from "./dag-call.js";
import { beginTrace, withTraceFields } from "../../core/trace.js";
export async function verifyDagIntegration(
  options: DagOptions,
  record: WorkflowRecord,
  signal: AbortSignal,
  save: () => Promise<void>,
) {
  const first = record.plan!.tasks[0]!;
  const integrationPlan: OfficialPlan = {
    summary:
      "Verify and review the complete integrated DAG; fix only originally approved files.",
    tasks: [
      {
        ...first,
        id: "integration",
        title: "Integration verification",
        instructions: record.goal,
        files: options.files,
        dependsOn: [],
        acceptance: options.tests.map((t) => t.id),
      },
    ],
  };
  const integrationOptions = {
    ...options,
    resume: undefined,
    approve: async () => false,
    save: async (value: WorkflowRecord) => {
      record.dag!.integration = structuredClone(value);
      record.head = value.head;
      record.correctionRounds = value.correctionRounds;
      record.commits = [...new Set([...record.commits, ...value.commits])];
      await save();
    },
  };
  if (!record.dag!.integration) {
    const seeded = checkpoint(
      integrationOptions,
      record.base,
      integrationPlan,
      record.id,
    );
    seeded.head = record.head;
    seeded.next = "verify";
    seeded.status = "verifying";
    record.dag!.integration = seeded;
    await save();
  }
  let integrated = record.dag!.integration;
  while (true) {
    if (integrated.status !== "completed")
      integrated = await withTraceFields(
        { agentId: `${record.id}:integration` },
        () =>
          runOfficialSingleTask(
            { ...integrationOptions, resume: integrated },
            signal,
          ),
      );
    if (integrated.status !== "completed")
      throw new WorkflowFailure(integrated.error ?? integrated.status);
    record.dag!.integration = integrated;
    // Mixed implementations need both providers to inspect the full fixed diff.
    if (
      new Set(record.plan!.tasks.map((t) => t.assignee.provider)).size > 1 &&
      record.dag!.crossReviewedHead !== record.head
    ) {
      const provider = first.assignee.provider,
        config = options.reviewers[provider]!;
      const model = options.models.find(
        (m) =>
          m.provider === provider &&
          m.model === config?.model &&
          m.available &&
          m.quotaAllowed === true &&
          m.efforts.includes(config.effort),
      );
      if (!model) throw new WorkflowFailure("reviewer-unavailable");
      const snapshot = await options.workspace.snapshot(
          record.base,
          record.head,
          signal,
        ),
        requestId = randomUUID();
      const entry = {
        requestId,
        phase: "review" as const,
        provider,
        requestedModel: model.model,
        effort: config.effort,
        status: "running" as const,
      };
      integrated.calls.push(entry);
      record.dag!.crossReviewPending = true;
      await save();
      const request: AgentRequest = {
        requestId,
        taskId: record.id,
        phase: "review",
        cwd: options.cwd,
        model,
        effort: config.effort,
        prompt: JSON.stringify({
          role: "read-only cross-provider DAG integration review",
          base: record.base,
          head: record.head,
          completeDiff: snapshot.diff,
          plan: record.plan,
          testEvidence: integrated.checks.at(-1)?.tests,
        }),
        files: [],
        tests: options.tests,
        outputSchema: schemas.review,
        timeoutMs: options.timeoutMs ?? 180000,
        approve: options.approveTool,
        tool: async (evidence) => {
          integrated.tools.push({ ...evidence, requestId });
          await save();
        },
      };
      const reviewSpan = beginTrace("tool", "RequestReview", {
        base: record.base,
        head: record.head,
        round: integrated.correctionRounds,
        officialNode: "integration",
      });
      const result = await withTraceFields(reviewSpan.fields, () =>
        runDagAgent(
          options.agents[provider],
          request,
          signal,
          options.simulated === true,
        ),
      );
      const { output, ...metadata } = result;
      integrated.calls[integrated.calls.length - 1] = {
        ...entry,
        ...metadata,
      };
      await save();
      if (result.status !== "completed")
        throw new WorkflowFailure(result.status);
      const review = reviewContract.parse(output);
      if (
        review.base !== record.base ||
        review.head !== record.head ||
        review.findings.some((f) => !snapshot.files.includes(f.file))
      )
        throw new WorkflowFailure("review-snapshot-mismatch");
      integrated.reviews.push(review);
      reviewSpan.end({
        content: JSON.stringify({
          ...review,
          phase: review.findings.some((f) => f.severity !== "nit")
            ? "implement"
            : "complete",
        }),
        isError: false,
      });
      if (review.findings.some((f) => f.severity !== "nit")) {
        if (integrated.correctionRounds >= 2)
          throw new WorkflowFailure("integration-cross-review-attention");
        integrated.correctionRounds++;
        integrated.next = "fix";
        integrated.status = "implementing";
        delete record.dag!.crossReviewPending;
        await save();
        continue;
      }
      record.dag!.crossReviewedHead = record.head;
      delete record.dag!.crossReviewPending;
      await save();
    }
    break;
  }
  return;
}
