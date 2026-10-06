import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { SessionStore, WorkspaceStore } from "./store.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type ProviderRequest } from "../providers/provider.js";
import { type UiEvent } from "../../shared/ipc.js";
import { parseCommand } from "../../shared/ipc.js";
import { loadAgentConfig } from "../agents/definitions.js";
import { Router } from "../core/router.js";
import { ChildRunner } from "../agents/runner.js";
import { projectMemoryTools } from "../tools/project-memory.js";
import { decidePermission } from "../core/permissions.js";
const done: FakeStep = {
  type: "message",
  stopReason: "end_turn",
  message: { role: "assistant", content: [{ type: "text", text: "done" }] },
};
const call = (name: string, input: unknown): FakeStep => ({
  type: "message",
  stopReason: "tool_use",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", name, id: name, input }],
  },
});
const fixtures: { base: string; c: SessionController }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.c.shutdown();
    await rm(f.base, { recursive: true, force: true });
  }
});
async function fixture(script: FakeStep[]) {
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
  const events: UiEvent[] = [],
    requests: ProviderRequest[] = [];
  const c = new SessionController({
    home,
    fake: true,
    model: "fake",
    version: "test",
    phase4: true,
    host: { pickFolder: async () => root },
    emit: (e) => events.push(e),
    provider: new FakeProvider({ script, onRequest: (r) => requests.push(r) }),
  });
  fixtures.push({ base, c });
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId });
  if (!created.ok || !created.sessionId) throw new Error("Missing session");
  const id = created.sessionId;
  const idle = () =>
    vi.waitFor(async () =>
      expect((await c.state()).sessions.find((s) => s.id === id)?.status).toBe(
        "idle",
      ),
    );
  return {
    home,
    root,
    sessions,
    workspaces,
    workspaceId,
    id,
    c,
    events,
    requests,
    idle,
  };
}
const draft = {
  kind: "decision" as const,
  topic: "SQLite",
  content: "Use SQLite",
  sources: [{ sessionId: "source", messageLine: 1 }],
};
it("proposal uses permission and needs separate explicit adoption; retrieval preserves fixed prefix without extra model calls", async () => {
  const f = await fixture([
    call("ProposeProjectMemory", draft),
    done,
    call("SearchProjectMemory", { query: "SQLite" }),
    done,
  ]);
  await f.c.handle({
    type: "send",
    sessionId: f.id,
    text: "Propose this lesson",
  });
  await vi.waitFor(() =>
    expect(
      f.events.some(
        (e) =>
          e.type === "permission_request" && e.tool === "ProposeProjectMemory",
      ),
    ).toBe(true),
  );
  const permission = f.events.find(
    (e) => e.type === "permission_request" && e.tool === "ProposeProjectMemory",
  ) as Extract<UiEvent, { type: "permission_request" }>;
  await f.c.handle({
    type: "permission_response",
    sessionId: f.id,
    requestId: permission.requestId,
    decision: "allow",
  });
  await f.idle();
  const list = await f.c.handle({
    type: "project_memory",
    sessionId: f.id,
    request: { action: "list" },
  });
  expect(list.ok && list.memory?.entries[0]?.status).toBe("candidate");
  const e = list.ok && list.memory?.entries[0];
  if (!e) throw new Error("Candidate missing");
  expect(f.requests).toHaveLength(2);
  expect(
    await f.c.handle({
      type: "project_memory",
      sessionId: f.id,
      request: { action: "accept", id: e.id, revision: e.revision, draft },
    }),
  ).toMatchObject({ ok: true });
  expect(f.requests).toHaveLength(2);
  await f.c.handle({
    type: "send",
    sessionId: f.id,
    text: "Reuse the SQLite decision",
  });
  await vi.waitFor(() =>
    expect(
      f.events.some(
        (e) =>
          e.type === "permission_request" && e.tool === "SearchProjectMemory",
      ),
    ).toBe(true),
  );
  const search = f.events.find(
    (e) => e.type === "permission_request" && e.tool === "SearchProjectMemory",
  ) as Extract<UiEvent, { type: "permission_request" }>;
  await f.c.handle({
    type: "permission_response",
    sessionId: f.id,
    requestId: search.requestId,
    decision: "allow",
  });
  await f.idle();
  expect(f.requests).toHaveLength(4);
  expect(f.requests[3]!.system).toBe(f.requests[0]!.system);
  expect(f.requests[3]!.tools).toEqual(f.requests[0]!.tools);
  const result = JSON.stringify(f.requests[3]!.messages.at(-1));
  expect(result).toContain("Use SQLite");
  expect(result).toContain("untrusted");
  expect(result).toContain("source");
});
it("plan/readOnly and explicit deny prevent candidate writes while readonly retrieval remains available", async () => {
  const f = await fixture([]);
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
it("readonly children only see explicitly configured memory retrieval, through their permission callback", async () => {
  const f = await fixture([]);
  const config = await loadAgentConfig(f.home);
  expect(config.agents.explorer?.tools).not.toContain("SearchProjectMemory");
  const permission = vi.fn(async () => false),
    requests: ProviderRequest[] = [];
  const runner = new ChildRunner({
    home: f.home,
    parentId: f.id,
    router: new Router([
      new FakeProvider({
        script: [call("SearchProjectMemory", { query: "SQLite" }), done],
        onRequest: (r) => requests.push(r),
      }),
    ]),
    createTools: (cwd) =>
      projectMemoryTools({
        home: f.home,
        sessions: f.sessions,
        workspaces: f.workspaces,
        sessionId: f.id,
        workspaceId: f.workspaceId,
        cwd,
        clean: (s) => s,
      }),
    permission,
  });
  await runner.run(
    "explorer",
    { model: "claude:sonnet", tools: ["SearchProjectMemory"] },
    "Read memory",
    f.root,
    new AbortController().signal,
  );
  expect(requests[0]?.tools?.map((t) => t.name)).toContain(
    "SearchProjectMemory",
  );
  expect(requests[0]?.tools?.map((t) => t.name)).not.toContain(
    "ProposeProjectMemory",
  );
  expect(permission).toHaveBeenCalled();
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
