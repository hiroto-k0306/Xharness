import { expect, it, vi, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./improvements.fixture.js";
import { type ImprovementAction } from "../../shared/improvements.js";
import { loadModelCatalog } from "../config/model-catalog.js";
import { loadCatalog, overrideCatalogForTest } from "../config/catalog.js";
afterEach(() => overrideCatalogForTest(undefined));

it("excludes retired models even when their catalog entry remains enabled", async () => {
  const catalog = structuredClone(loadCatalog());
  const template = catalog.models.find(
    (model) => model.id === "claude-sonnet-5-5",
  )!;
  const retired = {
    ...template,
    id: "retired-candidate-fixture",
    enabled: true,
    retiresAt: "2020-01-01",
  };
  delete retired.alias;
  catalog.models.push(retired);
  overrideCatalogForTest(catalog);
  const f = await fixture();
  const e = await f.baseline();
  const result = await f.action({
    action: "model_candidates",
    id: e.id,
    revision: e.revision,
    versionId: e.versions[0]!.id,
    caseId: "ping",
  });
  if (!result.ok || !result.modelCandidates) throw Error("candidate view");
  expect(result.modelCandidates.candidates.length).toBeGreaterThan(0);
  expect(
    result.modelCandidates.candidates.some(
      (model) => model.model === retired.id,
    ),
  ).toBe(false);
  expect(f.requests).not.toHaveBeenCalled();
});
it("does not let aliases redirect a confirmed canonical candidate and preserves readonly policy", async () => {
  const f = await fixture(),
    e = await f.baseline();
  const query = {
    action: "model_candidates" as const,
    id: e.id,
    revision: e.revision,
    versionId: e.versions[0]!.id,
    caseId: "ping",
  };
  const readonly = await f.c.handle({
    type: "new_session",
    workspaceId: f.workspaceId,
    readOnly: true,
  });
  if (!readonly.ok || !readonly.sessionId) throw new Error("readonly");
  expect(await f.action(query, f.c, readonly.sessionId)).toMatchObject({
    ok: false,
  });
  const first = await f.action(query);
  if (!first.ok || !first.modelCandidates) throw new Error("candidates");
  const enabled = loadModelCatalog().filter((model) => model.enabled);
  expect(first.modelCandidates.candidates.length).toBeGreaterThan(0);
  expect(
    first.modelCandidates.candidates.every((candidate) =>
      enabled.some(
        (model) =>
          model.id === candidate.model && model.provider === candidate.provider,
      ),
    ),
  ).toBe(true);
  expect(
    first.modelCandidates.candidates.some(
      (candidate) => candidate.model === "fake",
    ),
  ).toBe(false);
  const target = first.modelCandidates.candidates.find(
    (c) => c.model !== "fake" && c.model !== "claude-sonnet-5-5",
  )!;
  await writeFile(
    join(f.home, "config.yaml"),
    `workflow: {mode: off}\naliases:\n  ${target.model}: claude-sonnet-5-5\n`,
  );
  const response = await f.action({
    ...query,
    action: "select_model_candidate",
    snapshot: first.modelCandidates.snapshot,
    candidateId: target.id,
    confirmed: true,
    reason: "canonical model",
  });
  expect(response).toMatchObject({
    ok: false,
    error: expect.stringContaining("alias"),
  });
  expect(
    (await f.c.state()).sessions.find((s) => s.id === f.sessionId)?.model,
  ).toBe("claude:opus");
  expect(f.requests).not.toHaveBeenCalled();
});
it(
  "records repeated fixed-task observations, offers mock as reference and explicitly selects only this session across restart",
  { timeout: 20_000 },
  async () => {
    const f = await fixture();
    let e = await f.baseline();
    e = (await f.evaluate(e, e.versions[0]!.id)).e;
    e = (await f.evaluate(e, e.versions[0]!.id)).e;
    expect(e.results).toHaveLength(2);
    const query = {
      action: "model_candidates" as const,
      id: e.id,
      revision: e.revision,
      versionId: e.versions[0]!.id,
      caseId: "ping",
    };
    const observed = await f.action(query);
    if (!observed.ok || !observed.modelCandidates)
      throw new Error(JSON.stringify(observed));
    const view = observed.modelCandidates;
    expect(view.candidates.every((c) => !c.priority)).toBe(true);
    expect(
      view.candidates.find(
        (c) => c.model === "claude-haiku-5-5" && c.effort === "medium",
      )?.samples,
    ).toHaveLength(2);
    const target = view.candidates.find((c) => c.model !== "claude-haiku-5-5")!;
    const select: ImprovementAction = {
      ...query,
      action: "select_model_candidate",
      snapshot: view.snapshot,
      candidateId: target.id,
      confirmed: true,
      reason: "Explicit reference choice, no production quality claim",
    };
    const calls = f.requests.mock.calls.length;
    const replies = await Promise.all([f.action(select), f.action(select)]);
    expect(
      replies.filter((r) => r.ok),
      JSON.stringify(replies),
    ).toHaveLength(1);
    expect(f.requests).toHaveBeenCalledTimes(calls);
    expect((await f.c.state()).model).toBe("claude:opus");
    expect(
      (await f.c.state()).sessions.find((s) => s.id === f.sessionId)?.model,
    ).toBe(target.model);
    await f.c.shutdown();
    const restart = f.create();
    await restart.init();
    expect(
      (await restart.state()).sessions.find((s) => s.id === f.sessionId)?.model,
    ).toBe(target.model);
    expect(f.requests).toHaveBeenCalledTimes(calls);
    expect(await f.action(select, restart)).toMatchObject({ ok: false });
  },
);
it("rejects changed conditions, explicit write denial, stale confirmation and cancellation without provider calls", async () => {
  let now = 1000;
  const f = await fixture(() => now),
    e = await f.baseline();
  const query = {
    action: "model_candidates" as const,
    id: e.id,
    revision: e.revision,
    versionId: e.versions[0]!.id,
    caseId: "ping",
  };
  const first = await f.action(query);
  if (!first.ok || !first.modelCandidates) throw new Error("candidate view");
  const target = first.modelCandidates.candidates.find(
    (c) => c.model !== "fake",
  )!;
  const select: ImprovementAction = {
    ...query,
    action: "select_model_candidate",
    snapshot: first.modelCandidates.snapshot,
    candidateId: target.id,
    confirmed: true,
    reason: "manual",
  };
  now += 60_001;
  expect(await f.action(select)).toMatchObject({
    ok: false,
    error: expect.stringContaining("期限切れ"),
  });
  const fresh = await f.action(query);
  if (!fresh.ok || !fresh.modelCandidates) throw new Error("fresh view");
  expect(fresh.modelCandidates.snapshot).not.toBe(select.snapshot);
  expect(await f.action(select)).toMatchObject({ ok: false });
  select.snapshot = fresh.modelCandidates.snapshot;
  await f.action({ action: "cancel" });
  expect(await f.action(select)).toMatchObject({ ok: false });
  const again = await f.action(query);
  if (!again.ok || !again.modelCandidates) throw new Error("new confirmation");
  select.snapshot = again.modelCandidates.snapshot;
  await f.c.handle({
    type: "set_model",
    sessionId: f.sessionId,
    model: target.model,
    effort: target.effort,
  });
  expect(await f.action(select)).toMatchObject({ ok: false });
  await writeFile(
    join(f.home, "config.yaml"),
    "permissions: {rules: [{tool: ProposeProjectMemory, decision: deny}]}\nworkflow: {mode: off}\n",
  );
  expect(await f.action(query)).toMatchObject({ ok: false });
  await writeFile(join(f.home, "config.yaml"), "workflow: {mode: off}\n");
  const work = f.action(query);
  await f.action({ action: "cancel" });
  expect(await work).toMatchObject({ ok: false });
  expect(f.requests).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});
