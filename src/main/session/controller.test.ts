import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type Tool } from "../tools/registry.js";
import { type UiEvent } from "../../shared/ipc.js";
import { defaultTools, SessionController, type Host } from "./controller.js";

let home: string;
let workspace: string;
let events: UiEvent[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "xh-home-"));
  workspace = await mkdtemp(join(tmpdir(), "xh-ws-"));
  events = [];
});
const readTool: Tool = {
  spec: { name: "Read", description: "Read", inputSchema: {} },
  readOnly: true,
  validate: async () => undefined,
  execute: async () => ({ content: "file body" }),
};
const writeTool: Tool = {
  ...readTool,
  spec: { ...readTool.spec, name: "Write" },
  readOnly: false,
};
function make(
  script?: FakeStep[],
  host: Partial<Host> = {},
  secrets: string[] = [],
) {
  const controller = new SessionController({
    provider: new FakeProvider({ script }),
    model: "fake",
    home,
    fake: true,
    version: "9.9.9",
    secrets,
    host: { pickFolder: async () => workspace, ...host },
    emit: (e) => events.push(e),
    createTools: (_cwd, readOnly) =>
      new Map(
        [readTool, writeTool]
          .filter((t) => !readOnly || t.readOnly)
          .map((t) => [t.spec.name, t]),
      ),
    sleep: async () => undefined,
  });
  return controller;
}
async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const idle = (id: string) =>
  events.some(
    (e) => e.type === "turn" && e.sessionId === id && e.status === "idle",
  );
const lastState = () =>
  [...events].reverse().find((e) => e.type === "state") as Extract<
    UiEvent,
    { type: "state" }
  >;

describe("SessionController", () => {
  it("starts a scratch session for 'その他' without a workspace", async () => {
    const c = make();
    await c.init();
    const r = await c.handle({ type: "new_session", workspaceId: null });
    expect(r.ok && r.sessionId).toBeTruthy();
    const s = lastState().state;
    expect(s.sessions[0]).toMatchObject({
      workspaceId: null,
      title: "New session",
    });
    expect(s.sessions[0]!.cwd).toContain(join(home, "scratch"));
  });
  it("opens a folder, remembers it, and runs a text turn with streamed events", async () => {
    const c = make();
    await c.init();
    const picked = await c.handle({ type: "pick_folder" });
    expect(picked).toMatchObject({ ok: true });
    const workspaceId = (picked as { workspaceId: string }).workspaceId;
    const created = await c.handle({ type: "new_session", workspaceId });
    const sessionId = (created as { sessionId: string }).sessionId;
    await c.handle({ type: "send", sessionId, text: "hello there" });
    await until(() => idle(sessionId));
    expect(
      events
        .filter((e) => e.type === "step")
        .map((e) => (e as { node: string }).node),
    ).toEqual(expect.arrayContaining(["context", "model", "receipt"]));
    const text = events
      .filter(
        (e): e is Extract<UiEvent, { type: "text_delta" }> =>
          e.type === "text_delta",
      )
      .map((e) => e.text)
      .join("");
    expect(text).toBe("pong");
    const state = lastState().state;
    expect(state.workspaces[0]).toMatchObject({ id: workspaceId });
    expect(state.sessions[0]).toMatchObject({
      title: "hello there",
      status: "idle",
    });
  });
  it("asks before a tool call, then continues after the user allows it", async () => {
    const c = make();
    await c.init();
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "read a.txt" });
    await until(() => events.some((e) => e.type === "permission_request"));
    const req = events.find((e) => e.type === "permission_request") as Extract<
      UiEvent,
      { type: "permission_request" }
    >;
    expect(req.tool).toBe("Read");
    expect(lastState().state.sessions[0]!.status).toBe("ask");
    expect(idle(sessionId)).toBe(false);
    await c.handle({
      type: "permission_response",
      sessionId,
      requestId: req.requestId,
      decision: "allow",
    });
    await until(() => idle(sessionId));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_result", isError: false }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission_resolved",
        decision: "allow",
      }),
    );
  });
  it("returns a denial to the model and marks the result as an error", async () => {
    const c = make();
    await c.init();
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "read a.txt" });
    await until(() => events.some((e) => e.type === "permission_request"));
    const req = events.find((e) => e.type === "permission_request") as Extract<
      UiEvent,
      { type: "permission_request" }
    >;
    await c.handle({
      type: "permission_response",
      sessionId,
      requestId: req.requestId,
      decision: "deny",
    });
    await until(() => idle(sessionId));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_result", isError: true }),
    );
  });
  it("'always' skips later prompts for that tool within the session only", async () => {
    const c = make([]);
    await c.init();
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "read one" });
    await until(() => events.some((e) => e.type === "permission_request"));
    const first = events.find(
      (e) => e.type === "permission_request",
    ) as Extract<UiEvent, { type: "permission_request" }>;
    await c.handle({
      type: "permission_response",
      sessionId,
      requestId: first.requestId,
      decision: "always",
    });
    await until(() => idle(sessionId));
    const before = events.filter((e) => e.type === "permission_request").length;
    events.length = 0;
    await c.handle({ type: "send", sessionId, text: "read two" });
    await until(() => idle(sessionId));
    expect(before).toBe(1);
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(
      0,
    );
    // 別のセッションでは再び確認する
    const other = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({
      type: "send",
      sessionId: other.sessionId,
      text: "read three",
    });
    await until(() => events.some((e) => e.type === "permission_request"));
  });
  it("aborts a running turn, releasing a pending permission", async () => {
    const c = make();
    await c.init();
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "read a.txt" });
    await until(() => events.some((e) => e.type === "permission_request"));
    await c.handle({ type: "abort", sessionId });
    await until(() => idle(sessionId));
    const done = events.find(
      (e) => e.type === "turn" && e.status === "idle",
    ) as Extract<UiEvent, { type: "turn" }>;
    expect(done.stopCause).toBe("aborted");
    expect(lastState().state.sessions[0]!.status).toBe("idle");
  });
  it("shows a Japanese notice for 429 and an auth error, never raw provider text", async () => {
    const c = make([{ type: "rate_limited" }]);
    await c.init();
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "hello" });
    await until(() => idle(sessionId));
    const errors = events
      .filter(
        (e): e is Extract<UiEvent, { type: "error" }> => e.type === "error",
      )
      .map((e) => e.message);
    expect(errors.join("|")).toContain("枠の上限");
    events.length = 0;
    const c2 = make([{ type: "error", kind: "authentication" }]);
    await c2.init();
    const s2 = (await c2.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c2.handle({ type: "send", sessionId: s2.sessionId, text: "hello" });
    await until(() => idle(s2.sessionId));
    expect(JSON.stringify(events)).toContain("公式 CLI");
  });
  it("recovers when the stream is cut mid-response", async () => {
    const c = make([
      { type: "fixture", name: "phase1-haiku-text", cutAfterEvents: 4 },
    ]);
    await c.init();
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "hi" });
    await until(() => idle(sessionId));
    expect(lastState().state.sessions[0]!.status).toBe("idle");
    // 次のメッセージは普通に送れる
    events.length = 0;
    await c.handle({ type: "send", sessionId, text: "again" });
    await until(() => idle(sessionId));
  });
  it("persists history and resumes it in a new controller", async () => {
    const c = make();
    await c.init();
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "remember me" });
    await until(() => idle(sessionId));
    events.length = 0;
    const c2 = make();
    await c2.init();
    await c2.handle({ type: "open_session", sessionId });
    const t = events.find((e) => e.type === "transcript") as Extract<
      UiEvent,
      { type: "transcript" }
    >;
    expect(t.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(t.items[0]).toMatchObject({ text: "remember me" });
  });
  it("redacts known secrets from stored history and UI events", async () => {
    const secret = "sk-ant-oat01-ABCDEFGHIJKLMNOP";
    const c = make(undefined, {}, [secret]);
    await c.init();
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: `my key is ${secret}` });
    await until(() => idle(sessionId));
    const stored = await readFile(
      join(home, "sessions", `${sessionId}.jsonl`),
      "utf8",
    );
    expect(stored).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
  });
  it("read-only sessions get no write-capable tool", async () => {
    const c = make([{ type: "fixture", name: "phase1-haiku-text" }]);
    await c.init();
    const picked = (await c.handle({ type: "pick_folder" })) as {
      workspaceId: string;
    };
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: picked.workspaceId,
      readOnly: true,
    })) as { sessionId: string };
    expect(
      lastState().state.sessions.find((s) => s.id === sessionId)?.readOnly,
    ).toBe(true);
  });
  it("default read-only tool set contains only read-only tools", () => {
    const all = [...defaultTools(workspace, false).keys()].sort();
    const ro = defaultTools(workspace, true);
    expect(all).toEqual(
      expect.arrayContaining(["Read", "Write", "Edit", "Bash"]),
    );
    expect([...ro.keys()].sort()).toEqual(["Glob", "Grep", "Read"]);
    expect([...ro.values()].every((t) => t.readOnly)).toBe(true);
  });
  it("rejects send for unknown sessions, double sends, unknown models, and a cancelled picker", async () => {
    const c = make();
    await c.init();
    expect(
      await c.handle({ type: "send", sessionId: "nope", text: "x" }),
    ).toMatchObject({ ok: false });
    expect(await c.handle({ type: "set_model", model: "gpt-x" })).toMatchObject(
      { ok: false },
    );
    expect(await c.handle({ type: "set_model", model: "fake" })).toMatchObject({
      ok: true,
    });
    const c2 = make(undefined, { pickFolder: async () => undefined });
    await c2.init();
    expect(await c2.handle({ type: "pick_folder" })).toMatchObject({
      ok: false,
    });
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: null,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "read a" });
    await until(() => events.some((e) => e.type === "permission_request"));
    expect(
      await c.handle({ type: "send", sessionId, text: "again" }),
    ).toMatchObject({ ok: false });
    await c.handle({ type: "abort", sessionId });
    await until(() => idle(sessionId));
  });
  it("forgets a workspace without deleting its sessions", async () => {
    const c = make();
    await c.init();
    const picked = (await c.handle({ type: "pick_folder" })) as {
      workspaceId: string;
    };
    await c.handle({ type: "new_session", workspaceId: picked.workspaceId });
    await c.handle({
      type: "forget_workspace",
      workspaceId: picked.workspaceId,
    });
    const s = lastState().state;
    expect(s.workspaces).toHaveLength(0);
    expect(s.sessions).toHaveLength(1);
  });
  it("loads the project's AGENTS.md only from the session cwd", async () => {
    await mkdir(join(workspace, "sub"), { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), "RULE-123");
    const seen: string[] = [];
    const c = new SessionController({
      provider: new FakeProvider({ onRequest: (r) => seen.push(r.system) }),
      model: "fake",
      home,
      fake: true,
      version: "1",
      host: { pickFolder: async () => workspace },
      emit: (e) => events.push(e),
      createTools: () => new Map(),
    });
    await c.init();
    const picked = (await c.handle({ type: "pick_folder" })) as {
      workspaceId: string;
    };
    const { sessionId } = (await c.handle({
      type: "new_session",
      workspaceId: picked.workspaceId,
    })) as { sessionId: string };
    await c.handle({ type: "send", sessionId, text: "hi" });
    await until(() => idle(sessionId));
    expect(seen[0]).toContain("RULE-123");
  });
});
