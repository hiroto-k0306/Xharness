import {
  normalizeTokens,
  type TokenTotals,
} from "../../providers/token-usage.js";
import {
  reviewContract,
  type AgentRequest,
  type OfficialAgent,
  type ModelCandidate,
} from "./contracts.js";
import type { WorkflowRecord } from "./runtime.js";

export interface CallTiming {
  wallMs: number;
  approvalWaitMs: number;
  activeMs: number;
  source: "harness-request-boundary";
}
export interface TaskClassification {
  kind:
    | "bug-fix"
    | "feature"
    | "refactor"
    | "documentation"
    | "testing"
    | "other"
    | "unknown";
  difficulty: "easy" | "moderate" | "hard" | "unknown";
}
export interface ModelPerformanceSample {
  workflowId: string;
  requestId: string;
  taskId: string;
  phase: "implement" | "fix";
  correctionRound: number;
  provider: "claude" | "codex";
  modelId: string;
  effort: AgentRequest["effort"];
  modelEvidence: "resolved-request" | "observed-single-model";
  observedMatch: boolean | null;
  classification: TaskClassification & {
    source: "planner-declared" | "missing";
  };
  review: {
    source: "public-fixed-review" | "missing";
    requestId: string | null;
    must: number | null;
    should: number | null;
    nit: number | null;
  };
  tokens: TokenTotals;
  usageScope: string | null;
  usageComplete: boolean | null;
  timing: {
    wallMs: number | null;
    approvalWaitMs: number | null;
    activeMs: number | null;
  };
}
const unknownTokens = (): TokenTotals => ({
  input: null,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  reasoning: null,
  total: null,
});
const numeric = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
const id = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[A-Za-z0-9._:-]{1,200}$/.test(s) &&
  !/(^|:)(opus|sonnet|haiku|astra|sol|luna)$/.test(s) &&
  !/^sk-/i.test(s);
/** New measurements preserve legacy elapsedMs; only known approval callback waits are excluded. */
export function measuredAgent(
  agent: OfficialAgent,
  now = () => performance.now(),
): OfficialAgent {
  return {
    provider: agent.provider,
    discover: (cwd, signal) => agent.discover(cwd, signal),
    run: async (request, signal) => {
      const started = now();
      let pending = 0,
        pausedAt = 0,
        waiting = 0;
      const result = await agent.run(
        {
          ...request,
          approve: async (...args) => {
            if (pending++ === 0) pausedAt = now();
            try {
              return await request.approve(...args);
            } finally {
              if (--pending === 0) waiting += Math.max(0, now() - pausedAt);
            }
          },
        },
        signal,
      );
      const finished = now(),
        wallMs = Math.max(0, Math.round(finished - started));
      const approvalWaitMs = Math.min(
        wallMs,
        Math.max(0, Math.round(waiting + (pending ? finished - pausedAt : 0))),
      );
      return {
        ...result,
        timing: {
          wallMs,
          approvalWaitMs,
          activeMs: wallMs - approvalWaitMs,
          source: "harness-request-boundary",
        },
      };
    },
  };
}
/** No prompts, findings text, answers or credentials are copied into performance evidence. */
export function modelPerformance(
  record: WorkflowRecord,
): ModelPerformanceSample[] {
  try {
    return extractModelPerformance(record);
  } catch {
    return [];
  }
}
function extractModelPerformance(
  record: WorkflowRecord,
): ModelPerformanceSample[] {
  if (
    record.simulated ||
    record.status !== "completed" ||
    record.next !== "complete" ||
    record.error ||
    record.pendingEffect ||
    !record.plan ||
    !Array.isArray(record.plan.tasks) ||
    !Array.isArray(record.calls) ||
    !record.finishedAt ||
    !Number.isFinite(Date.parse(record.finishedAt))
  )
    return [];
  const output: ModelPerformanceSample[] = [];
  for (let index = 0; index < record.calls.length; index++) {
    const call = record.calls[index]!;
    if (!call || typeof call !== "object") continue;
    if (
      (call.phase !== "implement" && call.phase !== "fix") ||
      call.status !== "completed" ||
      !call.dispatched
    )
      continue;
    const task = call.nodeId
      ? record.plan.tasks.find((t) => t.id === call.nodeId)
      : record.plan.tasks.length === 1
        ? record.plan.tasks[0]
        : undefined;
    if (!task || task.assignee.provider !== call.provider) continue;
    const resolved = call.modelSelection?.resolved;
    if (
      resolved &&
      (resolved.provider !== call.provider ||
        resolved.effort !== call.effort ||
        resolved.model !== call.requestedModel ||
        !id(resolved.model))
    )
      continue;
    const observations = Array.isArray(call.observedModels)
      ? call.observedModels
      : [];
    const observed = observations.filter(id);
    const modelId =
      resolved?.provider === call.provider &&
      resolved.effort === call.effort &&
      id(resolved.model)
        ? resolved.model
        : observed.length === 1
          ? observed[0]
          : undefined;
    if (!modelId) continue;
    const modelEvidence =
      resolved?.model === modelId
        ? "resolved-request"
        : "observed-single-model";
    const mixedUsageModels =
      Array.isArray(call.usage?.byModel) &&
      call.usage!.byModel.some(
        (entry) =>
          entry && typeof entry.model === "string" && entry.model !== modelId,
      );
    const observedMatch = mixedUsageModels
      ? false
      : observations.length
        ? observed.length === observations.length &&
          observed.every((m) => m === modelId)
        : null;
    // A query pipeline that observed other models cannot attribute the aggregate tokens to this implementation model.
    const usageScope =
      typeof call.usage?.scope === "string" &&
      [
        "query-pipeline",
        "partial-main-loop",
        "main-loop",
        "thread-cumulative",
      ].includes(call.usage.scope)
        ? call.usage.scope
        : null;
    let tokens = unknownTokens();
    if (
      call.usage &&
      usageScope &&
      usageScope !== "thread-cumulative" &&
      Array.isArray(call.usage.byModel) &&
      call.usage.byModel.every((entry) => entry && entry.model === modelId) &&
      observedMatch !== false &&
      call.usage.measurement?.provider === call.provider &&
      call.usage.measurement.raw &&
      typeof call.usage.measurement.raw === "object"
    ) {
      try {
        tokens = normalizeTokens(call.usage.measurement);
      } catch {
        /* Legacy usage omissions remain missing. */
      }
    }
    let review: ModelPerformanceSample["review"] = {
      source: "missing",
      requestId: null,
      must: null,
      should: null,
      nit: null,
    };
    for (const next of record.calls.slice(index + 1)) {
      if (!next || next.nodeId !== call.nodeId) continue;
      if (next.phase === "implement" || next.phase === "fix") break;
      if (next.phase !== "review") continue;
      if (
        next.status !== "completed" ||
        !next.dispatched ||
        next.provider !== task.reviewer?.provider ||
        next.provider === call.provider ||
        !next.communication?.output ||
        next.communication.output.truncated
      )
        break;
      try {
        const parsed = reviewContract.parse(
          JSON.parse(next.communication.output.text),
        );
        const savedReviews = call.nodeId
          ? record.dag?.nodes.find((n) => n.id === call.nodeId)?.record?.reviews
          : record.reviews;
        const saved = Array.isArray(savedReviews)
          ? savedReviews.find(
              (r) =>
                r.base === parsed.base &&
                r.head === parsed.head &&
                JSON.stringify(r) === JSON.stringify(parsed),
            )
          : undefined;
        if (!saved) break;
        review = {
          source: "public-fixed-review",
          requestId: next.requestId,
          must: parsed.findings.filter((f) => f.severity === "must").length,
          should: parsed.findings.filter((f) => f.severity === "should").length,
          nit: parsed.findings.filter((f) => f.severity === "nit").length,
        };
      } catch {
        /* Missing or truncated historical reviews are not zero findings. */
      }
      break;
    }
    const timing = call.timing;
    const measured =
      timing?.source === "harness-request-boundary" &&
      numeric(timing.wallMs) &&
      numeric(timing.approvalWaitMs) &&
      numeric(timing.activeMs) &&
      timing.wallMs === timing.approvalWaitMs + timing.activeMs;
    const rawClassification = task.classification;
    const kind =
      rawClassification &&
      [
        "bug-fix",
        "feature",
        "refactor",
        "documentation",
        "testing",
        "other",
        "unknown",
      ].includes(rawClassification.kind)
        ? rawClassification.kind
        : "unknown";
    const difficulty =
      rawClassification &&
      ["easy", "moderate", "hard", "unknown"].includes(
        rawClassification.difficulty,
      )
        ? rawClassification.difficulty
        : "unknown";
    const classification: TaskClassification = { kind, difficulty };
    output.push({
      workflowId: record.id,
      requestId: call.requestId,
      taskId: task.id,
      phase: call.phase,
      correctionRound: record.calls
        .slice(0, index)
        .filter(
          (c) =>
            c.nodeId === call.nodeId &&
            (c.phase === "implement" || c.phase === "fix"),
        ).length,
      provider: call.provider,
      modelId,
      effort: call.effort,
      modelEvidence,
      observedMatch,
      classification: {
        ...classification,
        source: task.classification ? "planner-declared" : "missing",
      },
      review,
      tokens,
      usageScope,
      usageComplete:
        typeof call.usage?.complete === "boolean" ? call.usage.complete : null,
      timing: measured
        ? {
            wallMs: timing!.wallMs,
            approvalWaitMs: timing!.approvalWaitMs,
            activeMs: timing!.activeMs,
          }
        : {
            wallMs: numeric(call.elapsedMs) ? call.elapsedMs : null,
            approvalWaitMs: null,
            activeMs: null,
          },
    });
  }
  return output;
}
export interface ModelFeedbackGroup {
  provider: ModelCandidate["provider"];
  modelId: string;
  effort: AgentRequest["effort"];
  kind: TaskClassification["kind"];
  difficulty: TaskClassification["difficulty"];
  sampleCount: number;
  workflowCount: number;
  reviewKnown: number;
  reviewMissing: number;
  findings: { must: number; should: number; nit: number };
  activeMs: { sum: number; known: number; missing: number };
  tokens: Record<
    keyof TokenTotals,
    { sum: number; known: number; missing: number }
  >;
  correctionCalls: number;
}
/** Exact generation/effort and difficulty strata only, bounded to recent completed evidence. LLM still chooses. */
function collectPlannerModelFeedback(
  records: Iterable<WorkflowRecord>,
  models: ModelCandidate[],
) {
  const usable = models.filter((m) => m.available && m.quotaAllowed === true);
  const allowed = new Set(
    models
      .filter((m) => m.available && m.quotaAllowed === true)
      .map((m) => JSON.stringify([m.provider, m.resolvedModel ?? m.model])),
  );
  const groups = new Map<string, ModelFeedbackGroup>(),
    workflows = new Map<string, Set<string>>();
  const recent = [...records]
    .filter(
      (r) =>
        !!r &&
        !r.simulated &&
        r.status === "completed" &&
        !r.pendingEffect &&
        !r.error,
    )
    .sort(
      (a, b) => Date.parse(b.finishedAt ?? "") - Date.parse(a.finishedAt ?? ""),
    )
    .slice(0, 200);
  let examined = 0;
  for (const record of recent)
    for (const sample of modelPerformance(record)) {
      if (++examined > 1000) break;
      if (sample.observedMatch === false) continue;
      if (
        !allowed.has(JSON.stringify([sample.provider, sample.modelId])) ||
        !usable.some(
          (m) =>
            m.provider === sample.provider &&
            (m.resolvedModel ?? m.model) === sample.modelId &&
            m.efforts.includes(sample.effort),
        )
      )
        continue;
      const key = JSON.stringify([
        sample.provider,
        sample.modelId,
        sample.effort,
        sample.classification.kind,
        sample.classification.difficulty,
      ]);
      let g = groups.get(key);
      if (!g) {
        if (groups.size >= 60) continue;
        g = {
          provider: sample.provider,
          modelId: sample.modelId,
          effort: sample.effort,
          kind: sample.classification.kind,
          difficulty: sample.classification.difficulty,
          sampleCount: 0,
          workflowCount: 0,
          reviewKnown: 0,
          reviewMissing: 0,
          findings: { must: 0, should: 0, nit: 0 },
          activeMs: { sum: 0, known: 0, missing: 0 },
          tokens: Object.fromEntries(
            Object.keys(sample.tokens).map((k) => [
              k,
              { sum: 0, known: 0, missing: 0 },
            ]),
          ) as ModelFeedbackGroup["tokens"],
          correctionCalls: 0,
        };
        groups.set(key, g);
        workflows.set(key, new Set());
      }
      g.sampleCount++;
      workflows.get(key)!.add(sample.workflowId);
      g.workflowCount = workflows.get(key)!.size;
      g.correctionCalls += sample.phase === "fix" ? 1 : 0;
      if (sample.review.source === "missing") g.reviewMissing++;
      else {
        g.reviewKnown++;
        for (const severity of ["must", "should", "nit"] as const)
          g.findings[severity] += sample.review[severity]!;
      }
      if (sample.timing.activeMs === null) g.activeMs.missing++;
      else {
        g.activeMs.known++;
        g.activeMs.sum += sample.timing.activeMs;
      }
      for (const k of Object.keys(g.tokens) as (keyof TokenTotals)[]) {
        const n = sample.tokens[k];
        if (n === null) g.tokens[k].missing++;
        else {
          g.tokens[k].known++;
          g.tokens[k].sum += n;
        }
      }
    }
  return {
    version: 1 as const,
    source: "local-completed-workflows" as const,
    instruction:
      "Reference evidence only; you choose models within availableModels and catalog/effort constraints. No ranking or success-rate score. Compare only exact model generation+effort and comparable planner-declared task kind/difficulty. High findings on hard tasks are not evidence of an inferior model. Sparse samples, correction dependence, unknown difficulty, reviewer variation, missing usage/time and observed mismatches limit inference. Never transfer evidence across generations or infer missing counts as zero. Do not invent runtime predictions.",
    groups: [...groups.values()],
  };
}

export function plannerModelFeedback(
  records: Iterable<WorkflowRecord>,
  models: ModelCandidate[],
) {
  try {
    return collectPlannerModelFeedback(records, models);
  } catch {
    return collectPlannerModelFeedback([], []);
  }
}
