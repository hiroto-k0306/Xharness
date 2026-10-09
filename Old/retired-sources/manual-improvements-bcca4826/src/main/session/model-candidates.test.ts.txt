import { expect, it, vi } from "vitest";
import { modelCandidates } from "./model-candidates.js";
import { loadImprovementTask } from "./improvement-results.js";
import { CandidateQuotas } from "./candidate-quota.js";
import {
  type Improvement,
  type ImprovementView,
  type ImprovementRow,
} from "../../shared/improvements.js";
import { type HistoryScope } from "../tools/project-history.js";
import { type TaskEvaluation } from "./evaluation.js";
vi.mock("./improvement-results.js", () => ({ loadImprovementTask: vi.fn() }));
// Synthetic offline policy fixtures only; these are never recorded as real measurements.
const models = [
  { id: "a", provider: "claude", efforts: ["high" as const] },
  { id: "b", provider: "claude", efforts: ["high" as const] },
  { id: "c", provider: "codex", efforts: ["high" as const] },
];
function fixture() {
  const e: Improvement = {
    id: "comparison",
    scope: "scope",
    name: "fixed",
    revision: 1,
    source: {},
    cases: [
      {
        id: "ping",
        prompt: "pong",
        taskType: "text",
        difficulty: "small",
        criteria: "explicit v1",
        environment: "same declared tree",
      },
    ],
    versions: [
      {
        id: "v1",
        name: "baseline",
        body: "answer",
        hash: "hash",
        createdAt: 0,
      },
    ],
    results: [],
    history: [],
  };
  const view: ImprovementView = { entries: [e], rows: [], limit: 20 };
  const tasks = new Map<string, TaskEvaluation>();
  vi.mocked(loadImprovementTask).mockImplementation(async (_s, _e, r) => ({
    task: tasks.get(r.taskId)!,
    traceHash: "trace",
    compared: {} as never,
    measuredAt: 1000,
  }));
  const add = (
    model: string,
    changes: Partial<ImprovementRow> = {},
    taskChanges: Partial<TaskEvaluation> = {},
  ) => {
    const id = `task-${tasks.size}`,
      provider = model === "c" ? "codex" : "claude";
    e.results.push({
      versionId: "v1",
      caseId: "ping",
      sessionId: id,
      taskId: id,
      traceHash: "trace",
      passed: true,
      evidence: "human inspected expected result",
    });
    view.rows.push({
      versionId: "v1",
      caseId: "ping",
      sessionId: id,
      taskId: id,
      quality: true,
      valid: true,
      resourceComparable: true,
      note: "synthetic policy branch",
      evidence: "human check",
      input: 10,
      output: 5,
      elapsedMs: 100,
      inputCoverage: "1/1",
      outputCoverage: "1/1",
      models: [model],
      ...changes,
    });
    tasks.set(id, {
      taskId: id,
      calls: [
        {
          provider,
          model,
          effort: "high",
          tokens: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: provider === "claude" ? 0 : null,
            reasoning: null,
            total: 15,
          },
          measurement: { provider, raw: {} },
        },
      ],
      recordingIncomplete: false,
      simulatedCalls: 0,
      ...taskChanges,
    } as TaskEvaluation);
    return tasks.get(id)!;
  };
  const scope = {
    sessions: { get: () => ({ model: "a", effort: "high" }) },
    sessionId: "target",
  } as unknown as HistoryScope;
  const selection = { id: e.id, revision: 1, versionId: "v1", caseId: "ping" };
  return { e, view, add, scope, selection };
}
it("prioritizes only quality-complete non-simulated measurements and preserves missing usage, failed quality and mixed configurations", async () => {
  const f = fixture();
  f.add("a");
  f.add("b", {
    input: null,
    inputCoverage: "0/1",
    resourceComparable: false,
    note: "欠測",
  });
  f.add("b", { quality: false, note: "品質未充足" });
  f.add(
    "b",
    { resourceComparable: false, note: "模擬" },
    { simulatedCalls: 1 },
  );
  const result = await modelCandidates(
    f.scope,
    f.view,
    f.selection,
    models,
    new CandidateQuotas(),
    1000,
  );
  expect(result.candidates[0]).toMatchObject({ model: "a", priority: true });
  f.add("a", { quality: false, note: "latest explicit failure" });
  expect(
    (
      await modelCandidates(
        f.scope,
        f.view,
        f.selection,
        models,
        new CandidateQuotas(),
        1000,
      )
    ).candidates.find((c) => c.model === "a")?.priority,
  ).toBe(false);
  f.view.rows.pop();
  f.e.results.pop();
  const b = result.candidates.find((c) => c.model === "b")!;
  expect(b.priority).toBe(false);
  expect(b.samples).toHaveLength(3);
  expect(b.samples[0]!.input).toBeNull();
  const mixed = f.add("b");
  mixed.calls.push({ ...mixed.calls[0]!, model: "a" });
  const omitted = await modelCandidates(
    f.scope,
    f.view,
    f.selection,
    models,
    new CandidateQuotas(),
    1000,
  );
  expect(omitted.omitted.join(" ")).toContain("混在");
  expect(omitted.candidates.every((c) => !c.priority)).toBe(true);
  f.view.rows[0]!.valid = false;
  expect(
    (
      await modelCandidates(
        f.scope,
        f.view,
        f.selection,
        models,
        new CandidateQuotas(),
        1000,
      )
    ).candidates.every((c) => !c.priority),
  ).toBe(true);
});
it("keeps ties and provider/cache differences incomparable and detects stale confirmation", async () => {
  const f = fixture();
  const a = f.add("a"),
    b = f.add("b");
  f.add("c", { input: 1, output: 1, elapsedMs: 1 });
  const read = (time: number) =>
    modelCandidates(
      f.scope,
      f.view,
      f.selection,
      models,
      new CandidateQuotas(),
      time,
    );
  const tied = await read(1000);
  expect(
    tied.candidates.find((x) => x.model === "a")!.reasons.join(" "),
  ).toContain("同率");
  expect(
    tied.candidates.find((x) => x.model === "b")!.reasons.join(" "),
  ).not.toContain("全項目で同等以下");
  f.view.rows[1]!.input = 1;
  f.view.rows[1]!.output = 1;
  f.view.rows[1]!.elapsedMs = 1;
  expect(
    (await read(1000)).candidates
      .find((x) => x.model === "a")!
      .reasons.join(" "),
  ).toContain("全項目で同等以下");
  b.calls[0]!.tokens.cacheRead = 5;
  expect(
    (await read(1000)).candidates
      .find((x) => x.model === "a")!
      .reasons.join(" "),
  ).not.toContain("全項目で同等以下");
  a.calls[0]!.tokens.cacheRead = null;
  expect(
    (await read(1000)).candidates
      .find((x) => x.model === "a")!
      .reasons.join(" "),
  ).toContain("比較不能");
  const before = await read(1000),
    after = await read(61_000);
  expect(before.snapshot).toBe(after.snapshot); // lifetime is owned by the controller preview
  expect(before.expiresAt).toBe(61_000);
  expect(after.observedAt).toBeGreaterThanOrEqual(before.expiresAt);
});
it("blocks every model in exhausted shared pools and leaves stale/mock quota explicitly uncertain", async () => {
  const f = fixture();
  f.add("a");
  f.add("b");
  f.add("c");
  const q = new CandidateQuotas();
  q.observe("claude", [{ name: "week", usedPercent: 100 }], 1000, false);
  q.limited("codex", 1000, false, 600);
  const result = await modelCandidates(
    f.scope,
    f.view,
    f.selection,
    models,
    q,
    1001,
  );
  expect(result.allExhausted).toBe(true);
  expect(result.candidates.every((x) => !x.selectable && !x.priority)).toBe(
    true,
  );
  const stale = await modelCandidates(
    f.scope,
    f.view,
    f.selection,
    models,
    q,
    400_000,
  );
  expect(
    stale.candidates.every((x) => x.selectable && x.quota.state === "stale"),
  ).toBe(true);
  expect(stale.snapshot).not.toBe(result.snapshot);
});
