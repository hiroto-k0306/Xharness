import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionStore } from "./store.js";
import { type UiEvent } from "../../shared/ipc.js";
import { type ImprovementAction } from "../../shared/improvements.js";
import { memoryHash } from "./memory-sources.js";
import { fixture, cases } from "./improvements.fixture.js";
it("versions fixed inputs, compares quality first and persists explicit adoption and restoration across restart", async () => {
  const f = await fixture();
  let e = await f.baseline();
  const baseline = e.versions[0]!.id;
  expect(f.requests).not.toHaveBeenCalled();
  expect(
    await f.action({
      action: "adopt",
      id: e.id,
      revision: e.revision,
      versionId: baseline,
      reason: "unmeasured",
      confirmed: true,
    }),
  ).toMatchObject({ ok: false });
  const measured = await f.evaluate(e, baseline);
  e = measured.e;
  expect(measured.view.rows[0]).toMatchObject({
    quality: true,
    valid: true,
    resourceComparable: false,
  });
  expect(measured.view.rows[0]!.note).toContain("模擬");
  const adopt = {
    action: "adopt" as const,
    id: e.id,
    revision: e.revision,
    versionId: baseline,
    reason: "Explicit offline acceptance, no production claim",
    confirmed: true as const,
  };
  const replies = await Promise.all([f.action(adopt), f.action(adopt)]);
  expect(replies.filter((r) => r.ok)).toHaveLength(1);
  e = (await f.list()).entries[0]!;
  await f.action({
    action: "candidate",
    id: e.id,
    revision: e.revision,
    parent: baseline,
    name: "concise-v2",
    body: "Answer pong only; verify the task",
  });
  e = (await f.list()).entries[0]!;
  const candidate = e.versions[1]!.id;
  e = (await f.evaluate(e, candidate)).e;
  expect(
    await f.action({
      action: "adopt",
      id: e.id,
      revision: e.revision,
      versionId: candidate,
      reason: "Both pass offline; choose revised reference manually",
      confirmed: true,
    }),
  ).toMatchObject({ ok: true });
  e = (await f.list()).entries[0]!;
  expect(e.versions[0]!.body).toBe("Answer briefly");
  await f.c.shutdown();
  const restarted = f.create();
  await restarted.init();
  const saved = (await f.list(restarted)).entries[0]!;
  expect(saved.adopted).toBe(candidate);
  const calls = f.requests.mock.calls.length;
  expect(
    await f.action(
      {
        action: "restore",
        id: e.id,
        revision: e.revision,
        versionId: baseline,
        reason: "Return to previously reviewed baseline",
        confirmed: true,
      },
      restarted,
    ),
  ).toMatchObject({ ok: true });
  const restored = (await f.list(restarted)).entries[0]!;
  expect(restored.adopted).toBe(baseline);
  expect(restored.history).toHaveLength(3);
  expect(f.requests).toHaveBeenCalledTimes(calls);
  expect(f.requests.mock.calls[1]![0].system).toEqual(
    f.requests.mock.calls[0]![0].system,
  );
  expect(f.requests.mock.calls[1]![0].tools).toEqual(
    f.requests.mock.calls[0]![0].tools,
  );
});
it("failed explicit quality, different input, unfinished records and changed evidence cannot be adopted", async () => {
  const f = await fixture();
  let e = await f.baseline();
  const id = e.versions[0]!.id;
  const bad = await f.evaluate(e, id, false);
  e = bad.e;
  expect(bad.view.rows[0]!.quality).toBe(false);
  expect(
    await f.action({
      action: "adopt",
      id: e.id,
      revision: e.revision,
      versionId: id,
      reason: "not passed",
      confirmed: true,
    }),
  ).toMatchObject({ ok: false });
  const store = new SessionStore(f.home);
  await store.load();
  await store.append(
    bad.id,
    [{ role: "user", content: [{ type: "text", text: "changed evaluation" }] }],
    (s) => s,
  );
  expect((await f.list()).rows[0]).toMatchObject({
    valid: false,
    quality: false,
    input: null,
  });
  await store.recordEvaluationTask(bad.id, e.results[0]!.taskId, false, false);
  expect((await f.list()).rows[0]!.valid).toBe(false);
  const mismatch = await f.action({
    action: "record",
    id: e.id,
    revision: e.revision,
    versionId: id,
    caseId: "missing",
    sessionId: f.sessionId,
    taskId: "current",
    passed: true,
    evidence: "model says passed",
  });
  expect(mismatch.ok).toBe(false);
});
it("skill hash confirmation can be denied or cancelled and file changes fence adoption/preparation", async () => {
  const f = await fixture(),
    folder = join(f.root, ".agents/skills/example");
  await mkdir(folder, { recursive: true });
  const text = "---\nname: example\ndescription: recipe\n---\nBody\n";
  await writeFile(join(folder, "SKILL.md"), text);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(text).digest("hex");
  const request: ImprovementAction = {
    action: "create",
    name: "Skill proposal",
    body: "User proposed reference",
    source: { skill: { source: ".agents/skills/example/SKILL.md", hash } },
    cases,
  };
  const deny = f.action(request);
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === "permission_request")).toBe(true),
  );
  const pending = f.events.find(
    (e) => e.type === "permission_request",
  )! as Extract<UiEvent, { type: "permission_request" }>;
  await f.c.handle({
    type: "permission_response",
    sessionId: f.sessionId,
    requestId: pending.requestId,
    decision: "deny",
  });
  expect(await deny).toMatchObject({ ok: false });
  f.events.length = 0;
  const cancelled = f.action(request);
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === "permission_request")).toBe(true),
  );
  await f.c.handle({
    type: "improvements",
    sessionId: f.sessionId,
    operationId: "stale",
    request: { action: "cancel" },
  });
  expect(
    (await f.c.state()).sessions.find((s) => s.id === f.sessionId)?.status,
  ).toBe("ask");
  await f.action({ action: "cancel" });
  expect(await cancelled).toMatchObject({ ok: false });
  expect((await f.list()).entries).toHaveLength(0);
  f.events.length = 0;
  const reloaded = f.action(request);
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === "permission_request")).toBe(true),
  );
  await f.c.handle({ type: "ready" });
  expect(await reloaded).toMatchObject({ ok: false });
  expect((await f.list()).entries).toHaveLength(0);
  f.events.length = 0;
  const success = f.action(request);
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === "permission_request")).toBe(true),
  );
  const p = f.events.find((e) => e.type === "permission_request")! as Extract<
    UiEvent,
    { type: "permission_request" }
  >;
  await f.c.handle({
    type: "permission_response",
    sessionId: f.sessionId,
    requestId: p.requestId,
    decision: "allow",
  });
  expect((await success).ok).toBe(true);
  const e = (await f.list()).entries[0]!;
  await writeFile(join(folder, "SKILL.md"), text + "changed");
  f.events.length = 0;
  const prepare = f.action({
    action: "prepare",
    id: e.id,
    revision: e.revision,
    versionId: e.versions[0]!.id,
    caseId: "ping",
  });
  await vi.waitFor(() =>
    expect(f.events.some((e) => e.type === "permission_request")).toBe(true),
  );
  const stale = f.events.find(
    (e) => e.type === "permission_request",
  )! as Extract<UiEvent, { type: "permission_request" }>;
  await f.c.handle({
    type: "permission_response",
    sessionId: f.sessionId,
    requestId: stale.requestId,
    decision: "allow",
  });
  expect(await prepare).toMatchObject({ ok: false });
  expect(f.requests).not.toHaveBeenCalled();
});
it("external ledger changes during validation do not overwrite files and corrupt restart data is quarantined", async () => {
  const f = await fixture();
  const e = await f.baseline();
  const path = join(f.home, "improvements.json"),
    original = await readFile(path, "utf8");
  const { Improvements } = await import("./improvements.js"),
    { WorkspaceStore } = await import("./store.js");
  const sessions = new SessionStore(f.home),
    workspaces = new WorkspaceStore(f.home);
  await sessions.load();
  await workspaces.load();
  const { ProjectMemory } = await import("./project-memory.js");
  const scope = {
    home: f.home,
    sessions,
    workspaces,
    sessionId: f.sessionId,
    workspaceId: f.workspaceId,
    cwd: f.root,
    clean: (s: string) => s,
  };
  const memory = new ProjectMemory(scope);
  await memory.action({
    action: "add",
    draft: {
      kind: "recipe",
      topic: "recipe",
      content: "User memory",
      sources: [],
    },
  });
  const m = (await memory.list()).entries[0]!;
  await memory.action({
    action: "accept",
    id: m.id,
    revision: m.revision,
    draft: { kind: m.kind, topic: m.topic, content: m.content, sources: [] },
  });
  vi.spyOn(ProjectMemory.prototype, "list").mockImplementationOnce(async () => {
    await writeFile(path, original + "\n");
    return {
      scope: e.scope,
      warnings: [],
      limit: 50,
      entries: [{ ...m, revision: 2, status: "accepted" }],
    };
  });
  await expect(
    new Improvements(scope).action({
      action: "create",
      name: "conflict",
      body: "body",
      cases,
      source: { memory: { id: m.id, revision: 2 } },
    }),
  ).rejects.toThrow("外部変更");
  expect(await readFile(path, "utf8")).toBe(original + "\n");
  await writeFile(path, "{broken");
  expect(await f.action({ action: "list" })).toMatchObject({ ok: false });
  expect((await f.list()).entries).toHaveLength(0);
  expect(memoryHash("a")).not.toBe(memoryHash("b"));
});
