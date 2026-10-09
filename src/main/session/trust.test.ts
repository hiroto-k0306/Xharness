// Legacy Bash allow rules never authorize native work; trust/read-only data is preserved.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { SessionController } from "./controller.js";
import { WorkspaceTrust } from "../config/trust.js";

const controllers: SessionController[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) await c.shutdown();
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function setup(config: string) {
  const home = await mkdtemp(join(tmpdir(), "xh-official-trust-"));
  const cwd = join(home, "workspace");
  roots.push(home);
  await mkdir(join(cwd, ".xharness"), { recursive: true });
  const path = join(cwd, ".xharness", "config.yaml");
  await writeFile(path, config);
  const legacy = new FakeProvider(),
    oldStream = vi.spyOn(legacy, "stream");
  const official = vi.fn<
    NonNullable<
      ConstructorParameters<typeof SessionController>[0]["officialSession"]
    >
  >(async () => ({
    summary: "未対応ルールの作業は開始しない",
    workflowId: "fixture",
    status: "completed" as const,
    taskRequired: true,
    intent: "work" as const,
  }));
  const c = new SessionController({
    home,
    model: "claude:opus",
    provider: legacy,
    fake: true,
    version: "test",
    officialSession: official,
    host: { pickFolder: async () => cwd },
    emit: () => {},
  });
  controllers.push(c);
  await c.init();
  const picked = await c.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("workspace");
  const created = await c.handle({
    type: "new_session",
    workspaceId: picked.workspaceId,
  });
  if (!created.ok || !created.sessionId) throw new Error("session");
  return { home, cwd, path, c, official, oldStream, id: created.sessionId };
}
async function idle(c: SessionController, id: string) {
  await vi.waitFor(async () =>
    expect((await c.state()).sessions.find((s) => s.id === id)?.status).toBe(
      "idle",
    ),
  );
}
it.each(["allow", "deny", "ask"])(
  "legacy %s rules cannot authorize automatic native work",
  async (decision) => {
    const config = `permissions:\n  rules: [{tool: Bash, decision: ${decision}}]\n`;
    const f = await setup(config);
    expect(
      await f.c.handle({
        type: "send",
        sessionId: f.id,
        text: "変更してください",
      }),
    ).toMatchObject({ ok: true });
    await idle(f.c, f.id);
    expect(f.official).toHaveBeenCalledTimes(1);
    expect(f.official.mock.calls[0]![0]).toMatchObject({
      automaticWork: false,
      autoOperations: false,
    });
    expect(f.oldStream).not.toHaveBeenCalled();
    expect(await readFile(f.path, "utf8")).toBe(config);
    expect(await new WorkspaceTrust(f.home).isTrusted(f.cwd)).toBe(false);
  },
);
it("a repository auto mode does not silently become a user operation grant", async () => {
  const config = "permissions: {mode: acceptEdits}\n";
  const f = await setup(config);
  await f.c.handle({ type: "send", sessionId: f.id, text: "作業してください" });
  await idle(f.c, f.id);
  expect(f.official.mock.calls[0]![0]).toMatchObject({
    automaticWork: false,
    autoOperations: false,
  });
  expect(await readFile(f.path, "utf8")).toBe(config);
  expect(f.oldStream).not.toHaveBeenCalled();
});
