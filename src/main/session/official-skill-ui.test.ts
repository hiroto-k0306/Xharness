import { mkdir, mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import type { UiEvent, HarnessCommand } from "../../shared/ipc.js";
import { parseCommand } from "../../shared/ipc.js";
const fixtures: { controller: SessionController; base: string }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.controller.shutdown();
    await rm(f.base, { recursive: true, force: true });
  }
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "xh-native-skill-ui-"));
  const home = join(base, "home"),
    root = join(base, "root");
  const source = join(root, ".claude/skills/example/SKILL.md");
  await mkdir(home);
  await mkdir(join(source, ".."), { recursive: true });
  await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
  await writeFile(
    source,
    "---\nname: example\ndescription: Offline example\n---\nPRIVATE FIXTURE BODY\n",
  );
  const events: UiEvent[] = [];
  const controller = new SessionController({
    home,
    fake: true,
    model: "claude:opus",
    version: "test",
    phase4: true,
    host: { pickFolder: async () => root },
    emit: (e) => events.push(e),
    provider: new FakeProvider(),
  });
  fixtures.push({ controller, base });
  await controller.init();
  const picked = await controller.handle({ type: "pick_folder" });
  if (!picked.ok || !picked.workspaceId) throw new Error("workspace missing");
  const created = await controller.handle({
    type: "new_session",
    workspaceId: picked.workspaceId,
    readOnly: true,
  });
  if (!created.ok || !created.sessionId) throw new Error("session missing");
  const id = created.sessionId;
  const run = async (
    request: Extract<HarnessCommand, { type: "official_skills" }>["request"],
    decision: "allow" | "deny" = "allow",
  ) => {
    events.splice(0);
    const job = controller.handle({
      type: "official_skills",
      sessionId: id,
      request,
    });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "permission_request")).toBe(true),
    );
    const event = events.find(
      (e) => e.type === "permission_request",
    ) as Extract<UiEvent, { type: "permission_request" }>;
    await controller.handle({
      type: "permission_response",
      sessionId: id,
      requestId: event.requestId,
      decision,
    });
    return job;
  };
  return { home, root, source, controller, id, run };
}
it("gates preview/selection, persists only pins and clears explicitly", async () => {
  const f = await fixture();
  const preview = await f.run({
    action: "preview",
    provider: "claude",
    source: f.source,
  });
  if (!preview.ok || !preview.officialSkills?.preview)
    throw new Error("preview missing");
  expect(preview.officialSkills.preview.files?.[0]?.body).toContain(
    "PRIVATE FIXTURE BODY",
  );
  const { provider, scope, name, source, hash, bundleHash } =
    preview.officialSkills.preview.entry;
  const selection = { provider, scope, name, source, hash, bundleHash };
  const selected = await f.run({ action: "select", selection });
  expect(selected).toEqual({
    ok: true,
    officialSkills: { selected: [selection] },
  });
  const index = await readFile(join(f.home, "sessions/index.json"), "utf8");
  expect(index).toContain(bundleHash);
  expect(index).not.toContain("PRIVATE FIXTURE BODY");
  expect(
    await f.controller.handle({
      type: "official_skills",
      sessionId: f.id,
      request: { action: "clear" },
    }),
  ).toEqual({ ok: true, officialSkills: { selected: [] } });
});
it("denied reads do not expose the body or select a skill", async () => {
  const f = await fixture();
  expect(
    await f.run(
      { action: "preview", provider: "claude", source: f.source },
      "deny",
    ),
  ).toEqual({ ok: false, error: "公式スキルの読取が拒否されました。" });
  expect(
    await readFile(join(f.home, "sessions/index.json"), "utf8"),
  ).not.toContain("officialSkills");
});
it("preserves permission changes made while a skill approval is pending", async () => {
  const f = await fixture();
  const preview = await f.run({
    action: "preview",
    provider: "claude",
    source: f.source,
  });
  if (!preview.ok || !preview.officialSkills?.preview)
    throw new Error("preview missing");
  const { provider, scope, name, source, hash, bundleHash } =
    preview.officialSkills.preview.entry;
  const job = f.run({
    action: "select",
    selection: { provider, scope, name, source, hash, bundleHash },
  });
  const changed = await f.controller.handle({
    type: "set_mode",
    sessionId: f.id,
    mode: "plan",
  });
  expect(changed.ok).toBe(true);
  expect((await job).ok).toBe(true);
  const index = JSON.parse(
    await readFile(join(f.home, "sessions/index.json"), "utf8"),
  );
  expect(index[0].permissionMode).toBe("plan");
  expect(index[0].officialSkills[0].bundleHash).toBe(bundleHash);
});
it("rejects renderer-provided bodies and injected skill roots at the IPC boundary", () => {
  expect(
    parseCommand({
      type: "official_skills",
      sessionId: "test",
      request: { action: "list", provider: "claude", userRoot: "/foreign" },
    }),
  ).toBeUndefined();
  expect(
    parseCommand({
      type: "official_skills",
      sessionId: "test",
      request: {
        action: "select",
        selection: { provider: "claude", body: "injected" },
      },
    }),
  ).toBeUndefined();
});
