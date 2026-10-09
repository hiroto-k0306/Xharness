import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionController } from "./controller.js";
import { type Provider } from "../providers/provider.js";
import { SessionStore } from "./store.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
it("applies project model and effort while preserving explicit CLI precedence", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-project-model-"));
  const root = await mkdtemp(join(tmpdir(), "xh-project-root-"));
  await mkdir(join(root, ".xharness"));
  await writeFile(
    join(root, ".xharness", "config.yaml"),
    "main: {model: claude:sonnet, effort: low}\n",
  );
  const provider: Provider = {
    id: "claude",
    models: () => [
      { id: "claude-opus-5-5", contextTokens: 1000000 },
      { id: "claude-sonnet-5-5", contextTokens: 1000000 },
    ],
    async *stream() {
      throw new Error("No network expected");
    },
  };
  for (const cli of [false, true]) {
    const c = new SessionController({
      home,
      provider,
      model: "claude-opus-5-5",
      effort: "high",
      phase4: true,
      fake: false,
      version: "test",
      host: { pickFolder: async () => root },
      emit: () => {},
      ...(cli ? { cliModel: "opus", cliEffort: "high" as const } : {}),
    });
    await c.init();
    const ws = await c.handle({ type: "pick_folder" });
    if (!ws.ok || !ws.workspaceId) throw new Error("workspace failed");
    const created = await c.handle({
      type: "new_session",
      workspaceId: ws.workspaceId,
    });
    if (!created.ok) throw new Error("session failed");
    const session = (await c.state()).sessions.find(
      (s) => s.id === created.sessionId,
    );
    expect(session?.model).toBe(cli ? "claude-opus-5-5" : "claude-sonnet-5-5");
    expect(session?.effort).toBe(cli ? "high" : "low");
    await c.shutdown();
  }
});
it("rejects duplicate official submissions, cancels the pending call and never clones in fake mode", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-official-pending-"));
  let started = false,
    cancelled = false;
  const c = new SessionController({
    home,
    provider: new FakeProvider(),
    model: "claude:opus",
    fake: true,
    version: "test",
    host: { pickFolder: async () => undefined },
    emit: () => {},
    officialSession: async (_request, signal) => {
      started = true;
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve();
          },
          { once: true },
        ),
      );
      return {
        summary: "cancelled",
        workflowId: "offline-pending",
        status: "cancelled",
      };
    },
  });
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId: null });
  if (!created.ok || !created.sessionId) throw new Error("session missing");
  await c.handle({ type: "send", sessionId: created.sessionId, text: "hold" });
  await until(() => started);
  expect(
    await c.handle({
      type: "send",
      sessionId: created.sessionId,
      text: "duplicate",
    }),
  ).toMatchObject({ ok: false });
  expect(
    (
      await c.handle({
        type: "open_repository",
        url: "https://example.com/a/b.git",
      })
    ).ok,
  ).toBe(false);
  await c.shutdown();
  expect(cancelled).toBe(true);
  const store = new SessionStore(home);
  await store.load();
  expect(store.list()).toHaveLength(1);
});
