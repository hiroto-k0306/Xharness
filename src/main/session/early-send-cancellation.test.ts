// Barriers and FakeProvider only: never CLI, credentials, HTTP or app startup.
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { SessionController } from "./controller.js";
import { SessionStore } from "./store.js";
import { type UiEvent } from "../../shared/ipc.js";

beforeEach(() =>
  vi.stubGlobal("fetch", () => {
    throw new Error("Offline only");
  }),
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
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "xh-early-home-"));
  const root = join(home, "workspace");
  await mkdir(root);
  const onRequest = vi.fn();
  const events: UiEvent[] = [];
  const options = {
    home,
    model: "claude:opus",
    fake: true,
    version: "test",
    host: { pickFolder: async () => root },
    officialSession: async () => {
      onRequest();
      return {
        workflowId: "offline",
        status: "completed" as const,
        summary: "offline",
      };
    },
    emit: (e: UiEvent) => events.push(e),
    provider: new FakeProvider({
      onRequest,
      script: [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "offline" }],
          },
          stopReason: "end_turn",
        },
      ],
    }),
  };
  const first = new SessionController(options);
  await first.init();
  const workspace = await first.handle({ type: "pick_folder" });
  if (!workspace.ok) throw new Error("fixture workspace failed");
  const created = await first.handle({
    type: "new_session",
    workspaceId: workspace.workspaceId!,
  });
  if (!created.ok || !created.sessionId) throw new Error("fixture failed");
  await first.shutdown();
  const controller = new SessionController(options);
  await controller.init();
  return { controller, home, id: created.sessionId, onRequest, events };
}

it.each(
  (["task state", "history"] as const).flatMap((stage) =>
    (["abort", "stop", "close_session", "shutdown"] as const).map(
      (action) => [stage, action] as const,
    ),
  ),
)("cancels %s preparation with %s", async (stage, action) => {
  const c = await fixture();
  const entered = deferred(),
    release = deferred();
  if (stage === "task state") {
    const load = SessionStore.prototype.evaluationTask;
    vi.spyOn(SessionStore.prototype, "evaluationTask").mockImplementationOnce(
      async function (this: SessionStore, id) {
        entered.resolve();
        await release.promise;
        return load.call(this, id);
      },
    );
  } else {
    const messages = SessionStore.prototype.messages;
    vi.spyOn(SessionStore.prototype, "messages").mockImplementationOnce(
      async function (this: SessionStore, id) {
        entered.resolve();
        await release.promise;
        return messages.call(this, id);
      },
    );
  }
  const sending = c.controller.handle({
    type: "send",
    sessionId: c.id,
    text: "must not reach provider",
  });
  await entered.promise;
  let shutdownFinished = false;
  const stopped =
    action === "shutdown"
      ? c.controller.shutdown().then(() => {
          shutdownFinished = true;
        })
      : action === "stop"
        ? c.controller.handle({ type: "send", sessionId: c.id, text: "/stop" })
        : c.controller.handle({ type: action, sessionId: c.id });
  // The control returns independently of config/history; shutdown waits for preparation.
  if (action === "shutdown") {
    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
  } else expect(await stopped).toMatchObject({ ok: true });
  release.resolve();
  expect(await sending).toMatchObject({
    ok: false,
    error: "送信を中断しました。",
  });
  await stopped;
  expect(c.onRequest).not.toHaveBeenCalled();
  await expect(
    readFile(join(c.home, "sessions", c.id + ".jsonl"), "utf8"),
  ).rejects.toMatchObject({ code: "ENOENT" });
  if (action !== "shutdown") {
    expect(
      await c.controller.handle({
        type: "send",
        sessionId: c.id,
        text: "next valid instruction",
      }),
    ).toMatchObject({ ok: true });
    // A normal instruction remains usable after the cancelled reservation releases.
    const end = Date.now() + 3000;
    while (
      !c.events.some(
        (e) => e.type === "turn" && e.status === "idle" && e.stopCause,
      )
    ) {
      if (Date.now() > end) throw new Error("mock turn timeout");
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(c.onRequest).toHaveBeenCalledTimes(1);
  }
  await c.controller.shutdown();
  vi.restoreAllMocks();
});
