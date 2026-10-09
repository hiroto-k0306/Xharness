import { expect, it, vi } from "vitest";
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./handoffs.fixture.js";
import { JsonFile, SessionStore, WorkspaceStore } from "./store.js";
import { Handoffs } from "./handoffs.js";
import { type HandoffAction } from "../../shared/handoffs.js";
import { parseCommand } from "../../shared/ipc.js";

async function setup(answer = "pong") {
  const f = await fixture(answer);
  const made = await f.c.handle({
    type: "new_session",
    workspaceId: f.workspaceId,
  });
  if (!made.ok || !made.sessionId) throw new Error("destination");
  const destination = made.sessionId;
  await f.c.handle({ type: "send", sessionId: f.sessionId, text: "ping" });
  await vi.waitFor(
    async () =>
      expect(
        (await f.c.state()).sessions.find((s) => s.id === f.sessionId)?.status,
      ).toBe("idle"),
    { timeout: 5000 },
  );
  const action = (request: HandoffAction, sessionId = f.sessionId, c = f.c) =>
    c.handle({ type: "handoffs", sessionId, request });
  const preview = async () => {
    const r = await action({ action: "preview", destinationId: destination });
    if (!r.ok || !r.handoffs?.preview) throw new Error(JSON.stringify(r));
    return r.handoffs.preview;
  };
  return { ...f, destination, action, preview };
}

it("previews without delivery; confirms once and preserves destination history/model/permissions across restart", async () => {
  const f = await setup(),
    count = f.requests.mock.calls.length;
  const before = (await f.c.state()).sessions.find(
    (s) => s.id === f.destination,
  );
  const p = await f.preview();
  expect(p.body).toBe("pong");
  expect(await f.action({ action: "list" }, f.destination)).toMatchObject({
    ok: true,
    handoffs: { records: [] },
  });
  const confirmations = await Promise.all(
    [1, 2].map(() =>
      f.action({ action: "confirm", previewId: p.id, confirmed: true }),
    ),
  );
  expect(confirmations.every((r) => r.ok)).toBe(true);
  const ledger = JSON.parse(
    await readFile(join(f.home, "handoffs.json"), "utf8"),
  );
  expect(ledger).toHaveLength(1);
  expect(ledger[0]).toMatchObject({
    id: p.id,
    body: "pong",
    sourceId: f.sessionId,
    destinationId: f.destination,
  });
  expect(ledger[0].receivedAt).toBeTruthy();
  expect(
    (await f.c.state()).sessions.find((s) => s.id === f.destination),
  ).toEqual(before);
  await expect(
    readFile(join(f.home, "sessions", `${f.destination}.jsonl`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const p2 = await f.preview();
  expect(
    (await f.action({ action: "confirm", previewId: p2.id, confirmed: true }))
      .ok,
  ).toBe(true);
  expect(
    JSON.parse(await readFile(join(f.home, "handoffs.json"), "utf8")),
  ).toHaveLength(1);
  await f.c.shutdown();
  const restarted = f.create();
  await restarted.init();
  expect(
    await f.action({ action: "list" }, f.destination, restarted),
  ).toMatchObject({
    ok: true,
    handoffs: { records: [{ id: p.id, body: "pong" }] },
  });
  expect(
    (
      await f.action(
        { action: "confirm", previewId: p.id, confirmed: true },
        f.sessionId,
        restarted,
      )
    ).ok,
  ).toBe(true);
  expect(f.requests).toHaveBeenCalledTimes(count);
}, 20000);

it("cancels, invalidates previews on ready/restart and detects modified source", async () => {
  const f = await setup();
  const p = await f.preview();
  await f.action({ action: "cancel", previewId: p.id });
  expect(
    (await f.action({ action: "confirm", previewId: p.id, confirmed: true }))
      .ok,
  ).toBe(false);
  const p2 = await f.preview();
  await f.c.handle({ type: "ready" });
  expect(
    (await f.action({ action: "confirm", previewId: p2.id, confirmed: true }))
      .ok,
  ).toBe(false);
  const p3 = await f.preview();
  await appendFile(
    join(f.home, "sessions", `${f.sessionId}.jsonl`),
    '\n{"role":"assistant","content":[{"type":"text","text":"changed"}]}\n',
  );
  expect(
    (await f.action({ action: "confirm", previewId: p3.id, confirmed: true }))
      .ok,
  ).toBe(false);
  await expect(readFile(join(f.home, "handoffs.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}, 20000);

it("rejects deleted destinations/sources and foreign projects; retains received snapshot after source deletion", async () => {
  const f = await setup(),
    p = await f.preview();
  const foreign = await f.c.handle({ type: "new_session", workspaceId: null });
  if (!foreign.ok || !foreign.sessionId) throw new Error("foreign");
  expect(
    (await f.action({ action: "preview", destinationId: foreign.sessionId }))
      .ok,
  ).toBe(false);
  await f.c.handle({
    type: "delete_session",
    sessionId: f.destination,
    confirmed: true,
  });
  expect(
    (await f.action({ action: "confirm", previewId: p.id, confirmed: true }))
      .ok,
  ).toBe(false);
  const newDest = await f.c.handle({
    type: "new_session",
    workspaceId: f.workspaceId,
  });
  if (!newDest.ok || !newDest.sessionId) throw new Error("destination");
  const r = await f.action({
    action: "preview",
    destinationId: newDest.sessionId,
  });
  if (!r.ok || !r.handoffs?.preview) throw new Error(JSON.stringify(r));
  await f.action({
    action: "confirm",
    previewId: r.handoffs.preview.id,
    confirmed: true,
  });
  await f.c.handle({
    type: "delete_session",
    sessionId: f.sessionId,
    confirmed: true,
  });
  expect(await f.action({ action: "list" }, newDest.sessionId)).toMatchObject({
    ok: true,
    handoffs: { records: [{ body: "pong", sourceAvailable: false }] },
  });
}, 20000);

it("does not falsely report delivery on atomic write failure; lost replies recover via persisted inbox", async () => {
  const f = await setup(),
    p = await f.preview();
  const original = JsonFile.prototype.write;
  vi.spyOn(JsonFile.prototype, "write").mockRejectedValueOnce(
    new Error("disk failure"),
  );
  expect(
    (await f.action({ action: "confirm", previewId: p.id, confirmed: true }))
      .ok,
  ).toBe(false);
  expect(await f.action({ action: "list" }, f.destination)).toMatchObject({
    ok: true,
    handoffs: { records: [] },
  });
  vi.restoreAllMocks();
  const again = await f.preview();
  vi.spyOn(JsonFile.prototype, "write").mockImplementationOnce(async function (
    this: JsonFile<unknown>,
    value,
  ) {
    await original.call(this, value);
    throw new Error("reply lost after commit");
  });
  expect(
    (
      await f.action({
        action: "confirm",
        previewId: again.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  vi.restoreAllMocks();
  expect(await f.action({ action: "list" }, f.destination)).toMatchObject({
    ok: true,
    handoffs: { records: [{ id: again.id }] },
  });
  expect(
    (
      await f.action({
        action: "confirm",
        previewId: again.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(true);
  expect(
    JSON.parse(await readFile(join(f.home, "handoffs.json"), "utf8")),
  ).toHaveLength(1);
}, 20000);

it("fails closed repeatedly on corrupt ledger instead of resending", async () => {
  const f = await setup();
  await writeFile(join(f.home, "handoffs.json"), "{torn");
  for (let i = 0; i < 2; i++)
    expect(
      (await f.action({ action: "preview", destinationId: f.destination })).ok,
    ).toBe(false);
  expect(await readFile(join(f.home, "handoffs.json"), "utf8")).toBe("{torn");
});

it("requires explicit confirmation in IPC; ignores user-supplied payload/system", () => {
  expect(
    parseCommand({
      type: "handoffs",
      sessionId: "s",
      request: { action: "confirm", previewId: "p" },
    }),
  ).toBeUndefined();
  expect(
    parseCommand({
      type: "handoffs",
      sessionId: "s",
      request: {
        action: "preview",
        destinationId: "d",
        body: "evil",
        system: "override",
      },
    }),
  ).toEqual({
    type: "handoffs",
    sessionId: "s",
    request: { action: "preview", destinationId: "d" },
  });
});

async function direct(f: Awaited<ReturnType<typeof setup>>, now = Date.now) {
  const sessions = new SessionStore(f.home),
    workspaces = new WorkspaceStore(f.home);
  await sessions.load();
  await workspaces.load();
  const source = sessions.get(f.sessionId)!;
  return {
    service: new Handoffs(f.home, now),
    scope: {
      home: f.home,
      sessions,
      workspaces,
      sessionId: source.id,
      workspaceId: source.workspaceId,
      cwd: source.cwd,
      clean: (s: string) => s,
    },
  };
}

it("expires previews, rejects destination project changes, and loses only undelivered previews on restart", async () => {
  const f = await setup();
  let now = Date.now();
  const { service, scope } = await direct(f, () => now);
  const p = (
    await service.run(scope, {
      action: "preview",
      destinationId: f.destination,
    })
  ).preview!;
  now += 60_001;
  await expect(
    service.run(scope, { action: "confirm", previewId: p.id, confirmed: true }),
  ).rejects.toThrow("失効");
  const p2 = (
    await service.run(scope, {
      action: "preview",
      destinationId: f.destination,
    })
  ).preview!;
  await expect(
    new Handoffs(f.home).run(scope, {
      action: "confirm",
      previewId: p2.id,
      confirmed: true,
    }),
  ).rejects.toThrow("失効");
  await scope.sessions.save({
    ...scope.sessions.get(f.destination)!,
    workspaceId: null,
  });
  await expect(
    service.run(scope, {
      action: "confirm",
      previewId: p2.id,
      confirmed: true,
    }),
  ).rejects.toThrow("project");
});

it("cancels an in-progress preview before it can create a confirmation ticket", async () => {
  const f = await setup(),
    { service, scope } = await direct(f);
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const job = service.run(
    scope,
    { action: "preview", destinationId: f.destination },
    async () => {
      entered();
      await barrier;
    },
  );
  await started;
  await service.run(scope, { action: "cancel", previewId: "all" });
  release();
  await expect(job).rejects.toThrow("取消");
});

it("copies only sanitized final text, never reasoning, tools, system or credentials", async () => {
  const f = await setup("safe result\napi_key=private-value"),
    { service, scope } = await direct(f);
  const final = (await scope.sessions.messages(f.sessionId)).at(-1)!;
  await scope.sessions.append(
    f.sessionId,
    [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            provider: "claude",
            payload: "hidden-private-reasoning",
          },
        ],
      },
      final,
    ],
    (s) => s,
  );
  const p = (
    await service.run(scope, {
      action: "preview",
      destinationId: f.destination,
    })
  ).preview!;
  expect(p.body).toBe("safe result\n[credential-like line omitted]");
  expect(JSON.stringify(p)).not.toContain("private-value");
  expect(JSON.stringify(p)).not.toContain("hidden-private-reasoning");
  await scope.sessions.recordEvaluationTask(
    f.sessionId,
    p.taskId,
    false,
    false,
  );
  await expect(
    service.run(scope, { action: "confirm", previewId: p.id, confirmed: true }),
  ).rejects.toThrow("確定");
});

it("honors source/destination plan, read-only and explicit write denial without provider calls", async () => {
  const f = await setup(),
    count = f.requests.mock.calls.length;
  const plan = await f.c.handle({
    type: "set_mode",
    sessionId: f.destination,
    mode: "plan",
  });
  expect(plan.ok).toBe(true);
  expect(
    (await f.action({ action: "preview", destinationId: f.destination })).ok,
  ).toBe(false);
  const readonly = await f.c.handle({
    type: "new_session",
    workspaceId: f.workspaceId,
    readOnly: true,
  });
  if (!readonly.ok || !readonly.sessionId) throw new Error("readOnly");
  expect(
    (await f.action({ action: "preview", destinationId: readonly.sessionId }))
      .ok,
  ).toBe(false);
  await f.c.handle({
    type: "set_mode",
    sessionId: f.destination,
    mode: "default",
  });
  await writeFile(
    join(f.home, "config.yaml"),
    "workflow: {mode: off}\npermissions: {rules: [{tool: ProposeProjectMemory, decision: deny}]}\n",
  );
  expect(
    (await f.action({ action: "preview", destinationId: f.destination })).ok,
  ).toBe(false);
  expect(f.requests).toHaveBeenCalledTimes(count);
});

it("holds both sessions through commit; cancellation after commit starts cannot retract a receive", async () => {
  const f = await setup(),
    p = await f.preview(),
    count = f.requests.mock.calls.length;
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const original = JsonFile.prototype.write;
  vi.spyOn(JsonFile.prototype, "write").mockImplementationOnce(async function (
    this: JsonFile<unknown>,
    value,
  ) {
    entered();
    await barrier;
    await original.call(this, value);
  });
  const committing = f.action({
    action: "confirm",
    previewId: p.id,
    confirmed: true,
  });
  await started;
  try {
    expect(
      (
        await f.c.handle({
          type: "delete_session",
          sessionId: f.destination,
          confirmed: true,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.c.handle({
          type: "set_mode",
          sessionId: f.destination,
          mode: "plan",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.c.handle({
          type: "forget_workspace",
          workspaceId: f.workspaceId,
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.c.handle({
          type: "send",
          sessionId: f.destination,
          text: "must not execute",
        })
      ).ok,
    ).toBe(false);
    await f.action({ action: "cancel", previewId: "all" });
  } finally {
    release();
  }
  expect((await committing).ok).toBe(true);
  expect(await f.action({ action: "list" }, f.destination)).toMatchObject({
    ok: true,
    handoffs: { records: [{ id: p.id }] },
  });
  expect(f.requests).toHaveBeenCalledTimes(count);
}, 20000);
