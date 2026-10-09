import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelPerformance,
  plannerModelFeedback,
  measuredAgent,
} from "./model-feedback.js";
import {
  fixturePlan,
  fixtureWorkflowOptions,
  fixtureAgents,
} from "./fixtures.js";
import { communicationText, communicationInput } from "./communication.js";
import { sdkUsage } from "./usage.js";
import { runNativeTask } from "./native-runtime.js";
import type { WorkflowRecord } from "./runtime.js";
import type {
  AgentRequest,
  OfficialAgent,
  ModelCandidate,
} from "./contracts.js";
const model = "claude-opus-synthetic-generation-a";
const candidate = (id = model): ModelCandidate => ({
  provider: "claude",
  model: "opus",
  resolvedModel: id,
  efforts: [null, "high"],
  available: true,
  quotaAllowed: true,
  capabilitySource: "official-sdk",
});
function record(): WorkflowRecord {
  const task = fixturePlan().tasks[0]!;
  task.classification = { kind: "bug-fix", difficulty: "hard" };
  const result: WorkflowRecord = {
    version: 1,
    id: randomUUID(),
    simulated: false,
    goal: "private task text must never enter feedback",
    cwd: "/synthetic",
    startedAt: "2026-10-09T01:00:00Z",
    finishedAt: "2026-10-09T01:01:00Z",
    status: "completed",
    next: "complete",
    base: "a".repeat(64),
    head: "b".repeat(64),
    correctionRounds: 0,
    plan: { summary: "private", tasks: [task] },
    calls: [],
    tools: [],
    checks: [],
    reviews: [],
    commits: [],
  };
  result.calls.push({
    requestId: randomUUID(),
    phase: "implement",
    provider: "claude",
    requestedModel: model,
    effort: "high",
    status: "completed",
    dispatched: true,
    observedModels: [model],
    elapsedMs: 999,
    usage: sdkUsage({
      modelUsage: {
        [model]: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
        },
      },
    }),
    modelSelection: {
      policy: { provider: "claude", model: "opus", effort: "high" },
      resolved: {
        provider: "claude",
        model,
        effort: "high",
        catalog: { version: 1, updatedAt: "synthetic", digest: "c".repeat(64) },
      },
      changed: false,
    },
    timing: {
      wallMs: 1000,
      approvalWaitMs: 600,
      activeMs: 400,
      source: "harness-request-boundary",
    },
  });
  const review = {
    base: result.base,
    head: result.head,
    findings: [
      {
        severity: "must" as const,
        file: "add.mjs",
        line: 1,
        message: "private review text",
        evidence: "private evidence",
      },
    ],
  };
  result.reviews.push(review);
  result.calls.push({
    requestId: randomUUID(),
    phase: "review",
    provider: "codex",
    requestedModel: "synthetic-sol",
    effort: null,
    status: "completed",
    dispatched: true,
    observedModels: [],
    elapsedMs: 1,
    usage: null,
    communication: {
      ...communicationInput("private prompt"),
      output: communicationText(review),
    },
  });
  return result;
}
it("records complete ID/effort, fixed public review severities, missing tokens, active time and planner-declared difficulty without text", () => {
  const r = record(),
    before = JSON.stringify(r),
    sample = modelPerformance(r)[0]!;
  expect(sample).toMatchObject({
    modelId: model,
    effort: "high",
    correctionRound: 0,
    modelEvidence: "resolved-request",
    classification: {
      kind: "bug-fix",
      difficulty: "hard",
      source: "planner-declared",
    },
    review: { source: "public-fixed-review", must: 1, should: 0, nit: 0 },
    timing: { wallMs: 1000, approvalWaitMs: 600, activeMs: 400 },
    tokens: {
      input: 15,
      output: 20,
      cacheRead: 3,
      cacheWrite: 2,
      reasoning: null,
      total: 35,
    },
  });
  expect(JSON.stringify(sample)).not.toContain("private");
  expect(JSON.stringify(r)).toBe(before);
});
it.each(["simulated", "unfinished", "pending", "failed", "undispatched"])(
  "excludes %s evidence",
  (kind) => {
    const r = record();
    if (kind === "simulated") r.simulated = true;
    if (kind === "unfinished") r.status = "implementing";
    if (kind === "pending") r.pendingEffect = { kind: "test", id: "unknown" };
    if (kind === "failed") r.status = "failed";
    if (kind === "undispatched" && r.calls[0]!.status !== "running")
      r.calls[0]!.dispatched = false;
    expect(modelPerformance(r)).toEqual([]);
  },
);
it.each([
  "truncated",
  "mismatched-head",
  "missing-public-output",
  "wrong-company",
])("review %s is missing, never zero findings", (kind) => {
  const r = record(),
    call = r.calls[1]!;
  if (kind === "truncated") call.communication!.output!.truncated = true;
  if (kind === "mismatched-head")
    call.communication!.output = communicationText({
      ...r.reviews[0],
      head: "d".repeat(64),
    });
  if (kind === "missing-public-output") delete call.communication;
  if (kind === "wrong-company") call.provider = "claude";
  expect(modelPerformance(r)[0]!.review).toMatchObject({
    source: "missing",
    must: null,
    should: null,
    nit: null,
  });
});
it("legacy missing clock/classification/usage remains missing without generation backfill", () => {
  const r = record();
  delete r.plan!.tasks[0]!.classification;
  delete r.calls[0]!.modelSelection;
  if (r.calls[0]!.status !== "running") {
    delete r.calls[0]!.timing;
    r.calls[0]!.usage = null;
  }
  const s = modelPerformance(r)[0]!;
  expect(s.modelEvidence).toBe("observed-single-model");
  expect(s.classification.source).toBe("missing");
  expect(s.timing).toEqual({
    wallMs: 999,
    approvalWaitMs: null,
    activeMs: null,
  });
  expect(Object.values(s.tokens).every((n) => n === null)).toBe(true);
  r.calls[0]!.requestedModel = model;
  if (r.calls[0]!.status !== "running") r.calls[0]!.observedModels = [];
  expect(modelPerformance(r)).toEqual([]);
});
it("effort mismatch and mixed-model/thread-cumulative usage cannot be attributed", () => {
  const r = record();
  r.calls[0]!.modelSelection!.resolved.effort = null;
  expect(modelPerformance(r)).toEqual([]);
  r.calls[0]!.modelSelection!.resolved.effort = "high";
  const call = r.calls[0]!;
  if (call.status === "running") throw Error("fixture");
  call.usage!.byModel.push({
    model: "other-generation",
    raw: { outputTokens: 2 },
  });
  expect(modelPerformance(r)[0]!.tokens.total).toBeNull();
  expect(plannerModelFeedback([r], [candidate()]).groups).toEqual([]);
  call.usage!.byModel = [];
  call.usage!.scope = "thread-cumulative";
  expect(modelPerformance(r)[0]!.tokens.total).toBeNull();
});
it("correction rounds link their own subsequent review and exclude overall DAG review from task evidence", () => {
  const r = record();
  const implement = structuredClone(r.calls[0]!);
  implement.requestId = randomUUID();
  implement.phase = "fix";
  r.calls.push(implement);
  const review = structuredClone(r.calls[1]!);
  review.requestId = randomUUID();
  review.communication!.output = communicationText({
    base: r.base,
    head: r.head,
    findings: [],
  });
  r.reviews.push({ base: r.base, head: r.head, findings: [] });
  r.calls.push(review);
  const samples = modelPerformance(r);
  expect(samples.map((s) => [s.correctionRound, s.review.must])).toEqual([
    [0, 1],
    [1, 0],
  ]);
  for (const c of r.calls) c.nodeId = r.plan!.tasks[0]!.id;
  r.dag = {
    maxParallel: 2,
    phase: "complete",
    nativeConversationResume: false,
    nodes: [
      {
        id: r.plan!.tasks[0]!.id,
        state: "completed",
        record: (() => {
          const child = structuredClone(r);
          child.calls = [];
          delete child.dag;
          return child;
        })(),
      },
    ],
  };
  r.calls.push({
    ...structuredClone(review),
    nodeId: undefined,
    communication: {
      ...communicationInput("overall"),
      output: communicationText({ ...r.reviews[0], findings: [] }),
    },
  });
  expect(modelPerformance(r).map((s) => s.review.must)).toEqual([1, 0]);
});
it("planner feedback preserves generation/effort/difficulty strata, catalog constraints and missing counts; no ranking", () => {
  const a = record(),
    b = record(),
    c = record();
  b.id = randomUUID();
  b.plan!.tasks[0]!.classification!.difficulty = "easy";
  c.calls[0]!.effort = null;
  c.calls[0]!.modelSelection!.resolved.effort = null;
  c.plan!.tasks[0]!.classification!.difficulty = "easy";
  const before = JSON.stringify([a, b, c]);
  const input = plannerModelFeedback([a, b, c], [candidate()]);
  expect(input.groups).toHaveLength(3);
  expect(input.groups.map((g) => g.workflowCount)).toEqual([1, 1, 1]);
  expect(input.groups.every((g) => g.tokens.reasoning.missing === 1)).toBe(
    true,
  );
  expect(input.instruction).toContain("High findings on hard tasks");
  expect(input).not.toHaveProperty("ranking");
  expect(JSON.stringify(input)).not.toContain("private");
  expect(JSON.stringify([a, b, c])).toBe(before);
  expect(
    plannerModelFeedback([a], [candidate("claude-opus-synthetic-generation-b")])
      .groups,
  ).toEqual([]);
  expect(
    plannerModelFeedback([a], [{ ...candidate(), available: false }]).groups,
  ).toEqual([]);
  expect(
    plannerModelFeedback([a], [{ ...candidate(), efforts: [null] }]).groups,
  ).toEqual([]);
});
it("measured agent excludes the union of overlapping approval waits and preserves decisions and legacy elapsedMs", async () => {
  let tick = 0;
  const waits: Array<(value: boolean) => void> = [];
  const signal = new AbortController().signal;
  const base: OfficialAgent = {
    provider: "claude",
    discover: async () => [],
    run: async (request) => {
      tick = 10;
      const a = request.approve("first", {}, signal);
      tick = 20;
      const b = request.approve("second", {}, signal);
      tick = 40;
      waits[0]!(true);
      expect(await a).toBe(true);
      tick = 70;
      waits[1]!(false);
      expect(await b).toBe(false);
      tick = 100;
      return {
        status: "completed",
        dispatched: true,
        observedModels: [],
        usage: null,
        elapsedMs: 999,
      };
    },
  };
  const request: AgentRequest = {
    requestId: randomUUID(),
    taskId: randomUUID(),
    phase: "implement",
    cwd: "/synthetic",
    model: candidate(),
    effort: "high",
    files: [],
    tests: [],
    prompt: "{}",
    outputSchema: {},
    timeoutMs: 120000,
    tool: async () => {},
    approve: () =>
      new Promise<boolean>((resolve) => {
        waits.push(resolve);
      }),
  };
  const result = await measuredAgent(base, () => tick).run(request, signal);
  expect(result.elapsedMs).toBe(999);
  expect(result.timing).toEqual({
    wallMs: 100,
    approvalWaitMs: 60,
    activeMs: 40,
    source: "harness-request-boundary",
  });
});
it("native planner receives bounded feedback reference while model selection remains schema/catalog validated", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-model-feedback-"));
  try {
    await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
    const agents = fixtureAgents("claude", false).agents;
    const run = agents.claude.run.bind(agents.claude);
    let received: unknown;
    agents.claude.run = async (request, signal) => {
      if (request.phase === "plan")
        received = JSON.parse(request.prompt).modelFeedback;
      return run(request, signal);
    };
    const modelFeedback = plannerModelFeedback([record()], [candidate()]);
    const options = fixtureWorkflowOptions(cwd, { agents, modelFeedback });
    const result = await runNativeTask(options, new AbortController().signal);
    expect(result.status).toBe("completed");
    expect(received).toEqual(modelFeedback);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it.each([
  "observations-undefined",
  "observations-null",
  "by-model-missing",
  "by-model-not-array",
  "measurement-missing",
  "measurement-raw-null",
  "call-null",
  "task-null",
])("malformed legacy %s stays passive and preserves other records", (kind) => {
  const bad = record();
  const call = bad.calls[0] as unknown as Record<string, unknown>;
  if (kind === "observations-undefined") delete call.observedModels;
  if (kind === "observations-null") call.observedModels = null;
  if (kind === "by-model-missing")
    delete (call.usage as Record<string, unknown>).byModel;
  if (kind === "by-model-not-array")
    (call.usage as Record<string, unknown>).byModel = "untrusted";
  if (kind === "measurement-missing")
    delete (call.usage as Record<string, unknown>).measurement;
  if (kind === "measurement-raw-null")
    (
      (call.usage as Record<string, unknown>).measurement as Record<
        string,
        unknown
      >
    ).raw = null;
  if (kind === "call-null")
    bad.calls[0] = null as unknown as WorkflowRecord["calls"][number];
  if (kind === "task-null")
    bad.plan!.tasks[0] = null as unknown as NonNullable<
      WorkflowRecord["plan"]
    >["tasks"][number];
  const good = record();
  const result = plannerModelFeedback([bad, good], [candidate()]);
  expect(result.groups.length).toBeGreaterThan(0);
  expect(result.groups[0]!.workflowCount).toBeGreaterThanOrEqual(1);
  expect(() => modelPerformance(bad)).not.toThrow();
});
it("wrong usage provider is missing; observed mismatch and inconsistent requested snapshot do not affect planner attribution", () => {
  const r = record();
  const call = r.calls[0]!;
  if (call.status === "running") throw Error("fixture");
  call.usage!.measurement.provider = "codex";
  expect(modelPerformance(r)[0]!.tokens.total).toBeNull();
  call.observedModels = ["other-complete-generation"];
  expect(modelPerformance(r)[0]!.observedMatch).toBe(false);
  expect(plannerModelFeedback([r], [candidate()]).groups).toEqual([]);
  call.observedModels = [];
  call.requestedModel = "different-complete-generation";
  expect(modelPerformance(r)).toEqual([]);
});
it("classification and usage metadata are projected to safe allowlisted fields; unavailable effort candidate cannot authorize feedback", () => {
  const r = record();
  r.plan!.tasks[0]!.classification = {
    kind: "bug-fix",
    difficulty: "hard",
    extra: "private-classification-text",
  } as NonNullable<
    NonNullable<WorkflowRecord["plan"]>["tasks"][number]["classification"]
  >;
  const call = r.calls[0]!;
  if (call.status === "running") throw Error("fixture");
  call.usage!.scope = "private-scope-text" as NonNullable<
    typeof call.usage
  >["scope"];
  call.usage!.complete = "private-complete-text" as unknown as boolean;
  expect(modelPerformance(r)[0]!.usageScope).toBeNull();
  expect(modelPerformance(r)[0]!.usageComplete).toBeNull();
  expect(JSON.stringify(modelPerformance(r))).not.toContain("private");
  expect(
    plannerModelFeedback(
      [r],
      [
        { ...candidate(), efforts: [null] },
        { ...candidate(), available: false, efforts: ["high"] },
      ],
    ).groups,
  ).toEqual([]);
});
