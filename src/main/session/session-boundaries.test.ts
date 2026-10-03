// Offline only: controlled I/O barriers and local dummy worktrees, never model APIs.
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
import { Repository } from "./repository.js";

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
    emit: () => {},
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
  return { home, root, id, controller, onRequest, store };
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
