import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture, cases } from "./improvements.fixture.js";
it("keeps readonly/plan/deny and foreign workspace boundaries for explicit UI operations", async () => {
  const f = await fixture(),
    e = await f.baseline();
  const readonly = await f.c.handle({
    type: "new_session",
    workspaceId: f.workspaceId,
    readOnly: true,
  });
  if (!readonly.ok || !readonly.sessionId) throw new Error("session");
  const candidate = {
    action: "candidate" as const,
    id: e.id,
    revision: e.revision,
    parent: e.versions[0]!.id,
    name: "v2",
    body: "v2 body",
  };
  expect(await f.action(candidate, f.c, readonly.sessionId)).toMatchObject({
    ok: false,
    error: expect.stringContaining("権限"),
  });
  await f.c.handle({ type: "set_mode", sessionId: f.sessionId, mode: "plan" });
  expect(await f.action(candidate)).toMatchObject({ ok: false });
  await f.c.handle({
    type: "set_mode",
    sessionId: f.sessionId,
    mode: "default",
  });
  await writeFile(
    join(f.home, "config.yaml"),
    "workflow: {mode: off}\npermissions: {rules: [{tool: ProposeProjectMemory, decision: deny}]}\n",
  );
  expect(await f.action(candidate)).toMatchObject({ ok: false });
  await writeFile(join(f.home, "config.yaml"), "workflow: {mode: off}\n");
  await f.c.handle({ type: "forget_workspace", workspaceId: f.workspaceId });
  expect(await f.action(candidate)).toMatchObject({ ok: false });
  expect(f.requests).not.toHaveBeenCalled();
});
it("pins accepted memory revisions and preserves the completed ledger on write failure", async () => {
  const f = await fixture();
  const add = await f.c.handle({
    type: "project_memory",
    sessionId: f.sessionId,
    request: {
      action: "add",
      draft: {
        kind: "recipe",
        topic: "recipe",
        content: "Manual recipe",
        sources: [],
      },
    },
  });
  if (!add.ok || !add.memory?.entries[0]) throw new Error("memory");
  const m = add.memory.entries[0];
  const accepted = await f.c.handle({
    type: "project_memory",
    sessionId: f.sessionId,
    request: {
      action: "accept",
      id: m.id,
      revision: m.revision,
      draft: { kind: m.kind, topic: m.topic, content: m.content, sources: [] },
    },
  });
  if (!accepted.ok || !accepted.memory?.entries[0]) throw new Error("memory");
  const revision = accepted.memory.entries[0].revision;
  const created = await f.action({
    action: "create",
    name: "memory-linked",
    body: "Manual improvement",
    cases,
    source: { memory: { id: m.id, revision } },
  });
  if (!created.ok || !created.improvements) throw new Error("improvement");
  const e = created.improvements.entries[0]!;
  await f.c.handle({
    type: "project_memory",
    sessionId: f.sessionId,
    request: { action: "invalidate", id: m.id, revision },
  });
  expect(
    await f.action({
      action: "prepare",
      id: e.id,
      revision: e.revision,
      versionId: e.versions[0]!.id,
      caseId: "ping",
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("メモリ") });
  const path = join(f.home, "improvements.json"),
    original = await readFile(path, "utf8");
  const { JsonFile } = await import("./store.js"),
    { vi } = await import("vitest");
  vi.spyOn(JsonFile.prototype, "write").mockRejectedValueOnce(
    new Error("mock disk failure"),
  );
  expect(
    await f.action({
      action: "candidate",
      id: e.id,
      revision: e.revision,
      parent: e.versions[0]!.id,
      name: "failed",
      body: "failed save",
    }),
  ).toMatchObject({ ok: false });
  expect(await readFile(path, "utf8")).toBe(original);
  expect(f.requests).not.toHaveBeenCalled();
});
it("requires every fixed case before a candidate can be accepted", async () => {
  const f = await fixture();
  const created = await f.action({
    action: "create",
    name: "two-cases",
    body: "fixed reference",
    source: {},
    cases: [
      ...cases,
      { ...cases[0]!, id: "second", prompt: "Second fixed task" },
    ],
  });
  if (!created.ok || !created.improvements) throw new Error("improvement");
  const evaluated = await f.evaluate(
    created.improvements.entries[0]!,
    created.improvements.entries[0]!.versions[0]!.id,
  );
  const e = evaluated.e;
  expect(
    await f.action({
      action: "adopt",
      id: e.id,
      revision: e.revision,
      versionId: e.versions[0]!.id,
      reason: "Only first case passed",
      confirmed: true,
    }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("全固定課題") });
});
