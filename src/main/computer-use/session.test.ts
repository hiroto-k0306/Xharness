import { expect, it, vi } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "../session/improvements.fixture.js";
import { FakeLocalBrowser } from "./fake-browser.js";
import { JsonFile } from "../session/store.js";
import { ReceiptStore } from "../session/receipts.js";
import { parseCommand } from "../../shared/ipc.js";
import { type LocalBrowserAction } from "../../shared/local-browser.js";

async function setup(timeout = 5000) {
  const browsers: FakeLocalBrowser[] = [];
  const f = await fixture(undefined, {
    localBrowserTimeoutMs: timeout,
    localBrowserFactory: () => {
      const b = new FakeLocalBrowser();
      browsers.push(b);
      return b;
    },
  });
  const action = (request: LocalBrowserAction, c = f.c) =>
    c.handle({ type: "local_browser", sessionId: f.sessionId, request });
  const observe = async () => {
    const r = await action({ action: "observe" });
    if (!r.ok || !r.localBrowser?.observation)
      throw new Error(JSON.stringify(r));
    return r.localBrowser.observation;
  };
  const prepare = async () => {
    const observation = await observe();
    const r = await action({
      action: "prepare",
      observationId: observation.id,
    });
    if (!r.ok || !r.localBrowser?.confirmation)
      throw new Error(JSON.stringify(r));
    return r.localBrowser.confirmation;
  };
  const journal = join(f.home, "local-browser", `${f.sessionId}.json`);
  return { ...f, browsers, action, observe, prepare, journal };
}

it("fences commands before awaiting browser close during shutdown", async () => {
  const f = await setup();
  await f.observe();
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closing = vi
    .spyOn(f.browsers[0]!, "close")
    .mockImplementation(async () => {
      await blocked;
    });
  const shutdown = f.c.shutdown();
  try {
    await vi.waitFor(() => expect(closing).toHaveBeenCalled());
    for (const command of [
      { type: "send", sessionId: f.sessionId, text: "must not execute" },
      { type: "new_session", workspaceId: f.workspaceId },
      { type: "set_mode", sessionId: f.sessionId, mode: "acceptEdits" },
    ] as const) {
      expect(await f.c.handle(command)).toMatchObject({
        ok: false,
        error: "アプリ終了処理中です。",
      });
    }
    expect(f.requests).not.toHaveBeenCalled();
  } finally {
    release();
    await shutdown;
  }
});

it("observes, explicitly confirms one click, durably receipts and stops; duplicate/restart never repeat", async () => {
  const f = await setup(),
    o = await f.observe();
  expect(f.browsers[0]!.count).toBe(0);
  const ready = await f.action({ action: "prepare", observationId: o.id });
  if (!ready.ok || !ready.localBrowser?.confirmation)
    throw new Error("prepare");
  expect(ready.localBrowser.phase).toBe("awaiting_confirmation");
  const id = ready.localBrowser.confirmation.id;
  const result = await f.action({
    action: "confirm",
    confirmationId: id,
    confirmed: true,
  });
  expect(result).toMatchObject({
    ok: true,
    localBrowser: {
      phase: "stopped",
      operations: [
        {
          id,
          status: "succeeded",
          countAfter: 1,
          tabId: o.tabId,
          frameHash: o.frameHash,
        },
      ],
    },
  });
  expect(f.browsers[0]).toMatchObject({ clicks: 1, closed: true, count: 1 });
  expect(JSON.parse(await readFile(f.journal, "utf8")).operations).toHaveLength(
    1,
  );
  const receipts = await new ReceiptStore(f.home).read(f.sessionId);
  expect(receipts.map((r) => r.tool)).toEqual([
    "LocalBrowserObserve",
    "LocalBrowserConfirm",
    "LocalBrowserConfirm",
    "LocalBrowserClick",
    "LocalBrowserClick",
  ]);
  expect(receipts.find((r) => r.id === `${id}-start`)?.input).toMatchObject({
    status: "pending",
  });
  expect(JSON.stringify(receipts)).not.toContain("data:image/png");
  expect(
    (await f.action({ action: "confirm", confirmationId: id, confirmed: true }))
      .ok,
  ).toBe(true);
  expect(f.browsers[0]!.clicks).toBe(1);
  await f.c.shutdown();
  const restarted = f.create();
  await restarted.init();
  expect(
    await f.action(
      { action: "confirm", confirmationId: id, confirmed: true },
      restarted,
    ),
  ).toMatchObject({
    ok: true,
    localBrowser: { operations: [{ id, status: "succeeded" }] },
  });
  expect(f.browsers).toHaveLength(1);
  expect(f.requests).not.toHaveBeenCalled();
  await expect(
    readFile(join(f.home, "sessions", `${f.sessionId}.jsonl`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
}, 20000);

it("binds generation, document, tab and changed target to observation; ready invalidates old confirmations", async () => {
  const f = await setup(),
    o = await f.observe();
  await f.observe();
  expect((await f.action({ action: "prepare", observationId: o.id })).ok).toBe(
    false,
  );
  const p = await f.prepare();
  f.browsers.at(-1)!.documentId = "changed-document";
  expect(
    (
      await f.action({
        action: "confirm",
        confirmationId: p.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  expect(f.browsers.at(-1)!.clicks).toBe(0);
  const p2 = await f.prepare();
  f.browsers.at(-1)!.changed = true;
  expect(
    (
      await f.action({
        action: "confirm",
        confirmationId: p2.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  const p3 = await f.prepare();
  await f.c.handle({ type: "ready" });
  expect(
    (
      await f.action({
        action: "confirm",
        confirmationId: p3.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  expect(f.browsers.every((b) => b.clicks === 0)).toBe(true);
  expect(f.requests).not.toHaveBeenCalled();
}, 20000);

it("requires explicit confirmation and current plan/read-only/deny permissions", async () => {
  expect(
    parseCommand({
      type: "local_browser",
      sessionId: "s",
      request: { action: "confirm", confirmationId: "p" },
    }),
  ).toBeUndefined();
  expect(
    parseCommand({
      type: "local_browser",
      sessionId: "s",
      request: {
        action: "observe",
        url: "https://outside.invalid",
        x: 99,
        script: "evil",
      },
    }),
  ).toEqual({
    type: "local_browser",
    sessionId: "s",
    request: { action: "observe" },
  });
  const f = await setup(),
    p = await f.prepare();
  await f.c.handle({ type: "set_mode", sessionId: f.sessionId, mode: "plan" });
  expect(
    (
      await f.action({
        action: "confirm",
        confirmationId: p.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  const o = await f.observe();
  expect((await f.action({ action: "prepare", observationId: o.id })).ok).toBe(
    false,
  );
  await f.c.handle({
    type: "set_mode",
    sessionId: f.sessionId,
    mode: "default",
  });
  const p2 = await f.prepare();
  await writeFile(
    join(f.home, "config.yaml"),
    "permissions: {rules: [{tool: LocalBrowserClick, decision: deny}]}\n",
  );
  expect(
    (
      await f.action({
        action: "confirm",
        confirmationId: p2.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  expect(f.browsers.every((b) => b.clicks === 0)).toBe(true);
});

it("rechecks the target after durable intent and audit writes, rejecting a changed frame without clicking", async () => {
  const f = await setup(),
    p = await f.prepare();
  const original = JsonFile.prototype.write;
  vi.spyOn(JsonFile.prototype, "write").mockImplementationOnce(async function (
    this: JsonFile<unknown>,
    value,
  ) {
    await original.call(this, value);
    f.browsers[0]!.changed = true;
  });
  const r = await f.action({
    action: "confirm",
    confirmationId: p.id,
    confirmed: true,
  });
  expect(r).toMatchObject({
    ok: true,
    localBrowser: { phase: "unknown", operations: [{ status: "unknown" }] },
  });
  expect(f.browsers[0]!.clicks).toBe(0);
  expect((await f.action({ action: "observe" })).ok).toBe(false);
});

it("does not click if intent or receipt storage fails; preserves uncertainty after action completion save fault", async () => {
  const f = await setup(),
    p = await f.prepare();
  vi.spyOn(JsonFile.prototype, "write").mockRejectedValueOnce(
    new Error("intent disk fault"),
  );
  await f.action({ action: "confirm", confirmationId: p.id, confirmed: true });
  expect(f.browsers[0]!.clicks).toBe(0);
  vi.restoreAllMocks();
  const p2 = await f.prepare();
  vi.spyOn(ReceiptStore.prototype, "append").mockRejectedValueOnce(
    new Error("receipt disk fault"),
  );
  await f.action({ action: "confirm", confirmationId: p2.id, confirmed: true });
  expect(f.browsers[1]!.clicks).toBe(0);
  vi.restoreAllMocks();
  const p3 = await f.prepare(),
    original = JsonFile.prototype.write;
  vi.spyOn(JsonFile.prototype, "write")
    .mockImplementationOnce(original)
    .mockRejectedValueOnce(new Error("completion fault"));
  expect(
    await f.action({
      action: "confirm",
      confirmationId: p3.id,
      confirmed: true,
    }),
  ).toMatchObject({ ok: true, localBrowser: { phase: "unknown" } });
  expect(f.browsers[2]!.clicks).toBe(1);
  vi.restoreAllMocks();
  await f.c.shutdown();
  const restarted = f.create();
  await restarted.init();
  expect(await f.action({ action: "view" }, restarted)).toMatchObject({
    ok: true,
    localBrowser: { phase: "unknown" },
  });
  expect(
    (
      await f.action(
        { action: "confirm", confirmationId: p3.id, confirmed: true },
        restarted,
      )
    ).ok,
  ).toBe(false);
  expect(f.browsers).toHaveLength(3);
}, 20000);

it("timeout and explicit stop close the adapter; uncertain operations cannot replay after restart", async () => {
  const f = await setup(30),
    p = await f.prepare();
  let release!: () => void;
  f.browsers[0]!.beforeClick = () =>
    new Promise<void>((r) => {
      release = r;
    });
  const result = await f.action({
    action: "confirm",
    confirmationId: p.id,
    confirmed: true,
  });
  expect(result).toMatchObject({
    ok: true,
    localBrowser: { phase: "unknown" },
  });
  expect(f.browsers[0]!.closed).toBe(true);
  release();
  await f.c.shutdown();
  const restarted = f.create();
  await restarted.init();
  expect((await f.action({ action: "observe" }, restarted)).ok).toBe(false);
  expect(f.browsers[0]!.clicks).toBe(0);
  expect(f.requests).not.toHaveBeenCalled();
});

it("ordinary stop cancels a pending operation and prevents concurrent click, deletion, mode/project change", async () => {
  const f = await setup(),
    p = await f.prepare();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  f.browsers[0]!.beforeClick = () => {
    entered();
    return new Promise<void>((r) => {
      release = r;
    });
  };
  const job = f.action({
    action: "confirm",
    confirmationId: p.id,
    confirmed: true,
  });
  await started;
  expect(
    (
      await f.action({
        action: "confirm",
        confirmationId: p.id,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.c.handle({
        type: "delete_session",
        sessionId: f.sessionId,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.c.handle({
        type: "set_mode",
        sessionId: f.sessionId,
        mode: "plan",
      })
    ).ok,
  ).toBe(false);
  expect(
    (await f.c.handle({ type: "forget_workspace", workspaceId: f.workspaceId }))
      .ok,
  ).toBe(false);
  await f.c.handle({ type: "abort", sessionId: f.sessionId });
  release();
  expect(await job).toMatchObject({
    ok: true,
    localBrowser: { phase: "unknown" },
  });
  expect(f.browsers[0]!.clicks).toBe(0);
  expect(f.requests).not.toHaveBeenCalled();
});
