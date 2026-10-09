// The former scheduler implementation was retired with the legacy execution path.
// Keep the public boundary: historical commands must not launch official or HTTP work.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { SessionStore } from "./store.js";
const controllers: SessionController[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.shutdown();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it.each([
  "/schedule after 1 modify files",
  "/schedule idle inspect",
  "/signal ready",
])("retired command cannot launch or persist work: %s", async (text) => {
  const home = await mkdtemp(join(tmpdir(), "xh-official-schedule-"));
  roots.push(home);
  const provider = new FakeProvider(),
    legacy = vi.spyOn(provider, "stream");
  const official = vi.fn(async () => ({
    status: "completed" as const,
    summary: "must not dispatch",
    workflowId: "fixture",
  }));
  const c = new SessionController({
    home,
    model: "claude:opus",
    provider,
    fake: true,
    version: "test",
    officialSession: official,
    host: { pickFolder: async () => undefined },
    emit: () => {},
  });
  controllers.push(c);
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId: null });
  if (!created.ok || !created.sessionId) throw new Error("session");
  expect(
    await c.handle({ type: "send", sessionId: created.sessionId, text }),
  ).toMatchObject({ ok: false, error: expect.stringContaining("slash") });
  expect(official).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
  const store = new SessionStore(home);
  await store.load();
  expect(await store.messages(created.sessionId)).toEqual([]);
});
