import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionController } from "./controller.js";
import { SessionStore, WorkspaceStore } from "./store.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { parseCommand } from "../../shared/ipc.js";
import { decidePermission } from "../core/permissions.js";
const fixtures: { base: string; c: SessionController }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.c.shutdown();
    await rm(f.base, { recursive: true, force: true });
  }
});
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "xh-memory-integration-")),
    home = join(base, "home"),
    root = join(base, "root");
  await mkdir(home);
  await mkdir(root);
  await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
  const sessions = new SessionStore(home),
    workspaces = new WorkspaceStore(home);
  await sessions.load();
  await workspaces.load();
  const workspaceId = await workspaces.add(root);
  await sessions.save({
    id: "source",
    workspaceId,
    cwd: root,
    title: "source",
    readOnly: false,
    createdAt: 10,
    updatedAt: 20,
    model: "fake",
    effort: "high",
    providers: [],
  });
  await sessions.append(
    "source",
    [{ role: "user", content: [{ type: "text", text: "SQLite decision" }] }],
    (s) => s,
  );
  const c = new SessionController({
    home,
    fake: true,
    model: "fake",
    version: "test",
    phase4: true,
    host: { pickFolder: async () => root },
    emit: () => {},
    provider: new FakeProvider(),
  });
  fixtures.push({ base, c });
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId });
  if (!created.ok || !created.sessionId) throw new Error("Missing session");
  const id = created.sessionId;
  return { root, id, c };
}

const draft = {
  kind: "decision" as const,
  topic: "SQLite",
  content: "Use SQLite",
  sources: [{ sessionId: "source", messageLine: 1 }],
};
it("plan/readOnly and explicit deny prevent candidate writes while readonly retrieval remains available", async () => {
  const f = await fixture();
  await f.c.handle({ type: "set_mode", sessionId: f.id, mode: "plan" });
  expect(
    await f.c.handle({
      type: "project_memory",
      sessionId: f.id,
      request: { action: "add", draft },
    }),
  ).toMatchObject({ ok: false });
  expect(
    await decidePermission(
      { id: "x", name: "ProposeProjectMemory", input: draft },
      {
        mode: "acceptEdits",
        rules: [{ tool: "ProposeProjectMemory", decision: "deny" }],
      },
      f.root,
    ),
  ).toBe("deny");
  expect(
    await decidePermission(
      { id: "x", name: "SearchProjectMemory", input: { query: "x" } },
      { mode: "plan", rules: [] },
      f.root,
      { readOnly: true },
    ),
  ).toBe("ask");
});
it("IPC cannot accept an agent's claimed accepted status or missing edit revision", () => {
  expect(
    parseCommand({
      type: "project_memory",
      sessionId: "x",
      request: { action: "add", draft: { ...draft, status: "accepted" } },
    }),
  ).toBeUndefined();
  expect(
    parseCommand({
      type: "project_memory",
      sessionId: "x",
      request: { action: "accept", id: "one", draft },
    }),
  ).toBeUndefined();
});
