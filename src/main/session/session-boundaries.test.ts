// Offline only: controlled I/O barriers and local dummy worktrees, never model APIs.
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
import { Repository } from "./repository.js";
import { FileCheckpointStore } from "../checkpoints/store.js";
import { JsonFile } from "./store.js";
import { type UiEvent } from "../../shared/ipc.js";

beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Offline only");
    }),
  ),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function fixture(worktree = false) {
  const home = await mkdtemp(join(tmpdir(), "xh-boundary-"));
  const root = join(home, "workspace");
  await mkdir(root);
  const onRequest = vi.fn();
  const events: UiEvent[] = [];
  const options = {
    home,
    model: "fake",
    fake: true,
    version: "test",
    provider: new FakeProvider({
      onRequest,
      script: [
        {
          type: "message" as const,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "offline" }],
          },
          stopReason: "end_turn" as const,
        },
      ],
    }),
    host: { pickFolder: async () => root },
    emit: (e: UiEvent) => events.push(e),
    createTools: () => new Map(),
  };
  const first = new SessionController(options);
  await first.init();
  const ws = await first.handle({ type: "pick_folder" });
  if (!ws.ok) throw new Error("fixture failed");
  const created = await first.handle({
    type: "new_session",
    workspaceId: ws.workspaceId!,
  });
  if (!created.ok || !created.sessionId) throw new Error("fixture failed");
  const id = created.sessionId;
  const store = new SessionStore(home);
  await store.load();
  if (worktree) {
    const path = join(home, "worktrees", ws.workspaceId!, id);
    await mkdir(path, { recursive: true });
    await store.save({
      ...store.get(id)!,
      cwd: path,
      worktree: { path, branch: "dummy", baseBranch: "main" },
    });
  }
  await first.shutdown();
  const controller = new SessionController(options);
  await controller.init();
  return { home, root, id, controller, onRequest, store, events, options };
}
it("reserves send preparation before history I/O so worktree removal cannot start", async () => {
  const c = await fixture(true);
  const entered = deferred(),
    release = deferred();
  const messages = SessionStore.prototype.messages;
  vi.spyOn(SessionStore.prototype, "messages").mockImplementationOnce(
    async function (this: SessionStore, id) {
      entered.resolve();
      await release.promise;
      return messages.call(this, id);
    },
  );
  const finish = vi.spyOn(Repository.prototype, "finish").mockResolvedValue();
  const send = c.controller.handle({
    type: "send",
    sessionId: c.id,
    text: "offline",
  });
  await entered.promise;
  expect(
    await c.controller.handle({
      type: "finish_worktree",
      sessionId: c.id,
      action: "remove",
      confirmed: true,
    }),
  ).toMatchObject({ ok: false });
  expect(finish).not.toHaveBeenCalled();
  release.resolve();
  expect(await send).toMatchObject({ ok: true });
  await c.controller.shutdown();
});
it("refuses sends while worktree removal is awaiting completion", async () => {
  const c = await fixture(true);
  const entered = deferred(),
    release = deferred();
  vi.spyOn(Repository.prototype, "finish").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const remove = c.controller.handle({
    type: "finish_worktree",
    sessionId: c.id,
    action: "remove",
    confirmed: true,
  });
  await entered.promise;
  expect(
    await c.controller.handle({
      type: "send",
      sessionId: c.id,
      text: "offline",
    }),
  ).toMatchObject({ ok: false });
  expect(c.onRequest).not.toHaveBeenCalled();
  release.resolve();
  expect(await remove).toMatchObject({ ok: true });
  await c.controller.shutdown();
});

it("refuses deletion during history loading, then deletes normally after cancellation", async () => {
  const c = await fixture();
  const entered = deferred(),
    release = deferred();
  vi.spyOn(SessionStore.prototype, "messages").mockImplementationOnce(
    async () => {
      entered.resolve();
      await release.promise;
      return [];
    },
  );
  const send = c.controller.handle({
    type: "send",
    sessionId: c.id,
    text: "offline",
  });
  await entered.promise;
  expect(
    await c.controller.handle({
      type: "delete_session",
      sessionId: c.id,
      confirmed: true,
    }),
  ).toMatchObject({ ok: false });
  release.resolve();
  await send;
  await c.controller.handle({ type: "abort", sessionId: c.id });
  await c.controller.shutdown();
  const restarted = new SessionController(c.options);
  await restarted.init();
  expect(
    await restarted.handle({
      type: "delete_session",
      sessionId: c.id,
      confirmed: true,
    }),
  ).toMatchObject({ ok: true });
  await c.store.load();
  expect(c.store.get(c.id)).toBeUndefined();
  await expect(
    readFile(join(c.home, "sessions", `${c.id}.jsonl`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await restarted.shutdown();
});

it("rejects new sends from deletion start until all disk cleanup completes", async () => {
  const c = await fixture();
  const entered = deferred(),
    release = deferred();
  const remove = FileCheckpointStore.prototype.remove;
  vi.spyOn(FileCheckpointStore.prototype, "remove").mockImplementationOnce(
    async function (this: FileCheckpointStore, id) {
      entered.resolve();
      await release.promise;
      await remove.call(this, id);
    },
  );
  const deletion = c.controller.handle({
    type: "delete_session",
    sessionId: c.id,
    confirmed: true,
  });
  await entered.promise;
  expect(
    await c.controller.handle({
      type: "send",
      sessionId: c.id,
      text: "offline",
    }),
  ).toMatchObject({ ok: false });
  expect(c.onRequest).not.toHaveBeenCalled();
  release.resolve();
  expect(await deletion).toMatchObject({ ok: true });
  expect((await c.controller.state()).sessions).toEqual([]);
  await c.controller.shutdown();
});

it("drains earlier saves and fences late history/save writes without resurrecting disk data", async () => {
  const c = await fixture();
  const session = c.store.get(c.id)!;
  const entered = deferred(),
    release = deferred();
  const write = JsonFile.prototype.write;
  vi.spyOn(JsonFile.prototype, "write").mockImplementationOnce(async function (
    this: JsonFile<unknown>,
    value,
  ) {
    entered.resolve();
    await release.promise;
    await write.call(this, value);
  });
  const saving = c.store.save({ ...session, title: "earlier save" });
  await entered.promise;
  const deleting = c.store.delete(c.id);
  expect(c.store.get(c.id)).toBeUndefined();
  const stale = Promise.all([
    c.store.append(
      c.id,
      [{ role: "assistant", content: [{ type: "text", text: "stale turn" }] }],
      (s) => s,
    ),
    c.store.save(session),
  ]);
  release.resolve();
  await Promise.all([saving, deleting, stale]);
  await c.store.load();
  expect(c.store.get(c.id)).toBeUndefined();
  expect(
    JSON.parse(await readFile(join(c.home, "sessions", "index.json"), "utf8")),
  ).toEqual([]);
  await expect(
    readFile(join(c.home, "sessions", `${c.id}.jsonl`)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await c.controller.shutdown();
});

it("rechecks the root when a different session starts worktree removal during history I/O", async () => {
  const c = await fixture(true);
  const parent = await c.controller.handle({
    type: "new_session",
    workspaceId: c.store.get(c.id)!.workspaceId,
  });
  if (!parent.ok || !parent.sessionId) throw new Error("fixture failed");
  await c.controller.handle({
    type: "close_session",
    sessionId: parent.sessionId,
  });
  const reading = deferred(),
    historyRelease = deferred(),
    removing = deferred(),
    removeRelease = deferred();
  vi.spyOn(SessionStore.prototype, "messages").mockImplementationOnce(
    async () => {
      reading.resolve();
      await historyRelease.promise;
      return [];
    },
  );
  vi.spyOn(Repository.prototype, "finish").mockImplementationOnce(async () => {
    removing.resolve();
    await removeRelease.promise;
  });
  const send = c.controller.handle({
    type: "send",
    sessionId: parent.sessionId,
    text: "offline",
  });
  await reading.promise;
  const remove = c.controller.handle({
    type: "finish_worktree",
    sessionId: c.id,
    action: "remove",
    confirmed: true,
  });
  await removing.promise;
  historyRelease.resolve();
  expect(await send).toMatchObject({
    ok: false,
    error: "Workspace writer busy",
  });
  expect(c.onRequest).not.toHaveBeenCalled();
  removeRelease.resolve();
  await remove;
  await c.controller.shutdown();
});

it("keeps due scheduled work pending while send preparation holds the shared reservation", async () => {
  const c = await fixture();
  vi.useFakeTimers();
  expect(
    await c.controller.handle({
      type: "send",
      sessionId: c.id,
      text: "/schedule after 1 queued",
    }),
  ).toMatchObject({ ok: true });
  const entered = deferred(),
    release = deferred();
  vi.spyOn(SessionStore.prototype, "messages").mockImplementationOnce(
    async () => {
      entered.resolve();
      await release.promise;
      return [];
    },
  );
  const send = c.controller.handle({
    type: "send",
    sessionId: c.id,
    text: "offline",
  });
  await entered.promise;
  await vi.advanceTimersByTimeAsync(1100);
  expect(c.onRequest).not.toHaveBeenCalled();
  expect(JSON.stringify(c.events)).not.toContain("送信を開始できなかった");
  release.resolve();
  await send;
  await vi.waitFor(() => expect(c.onRequest).toHaveBeenCalledTimes(2), {
    timeout: 10000,
  });
  await c.controller.shutdown();
});
