import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type Tool } from "../tools/registry.js";
import { type UiEvent } from "../../shared/ipc.js";
import { defaultTools, SessionController, type Host } from "./controller.js";
import { SessionStore } from "./store.js";

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
it.each([
  "/stop",
  "一旦停止して",
  "停止",
  "停止して",
  "止めて",
  "中断",
  "一旦停止！",
])("handles %s locally and aborts a permission wait", async (text) => {
  const c = make();
  await c.init();
  const { sessionId } = (await c.handle({
    type: "new_session",
    workspaceId: null,
  })) as { sessionId: string };
  await c.handle({ type: "send", sessionId, text: "read a.txt" });
  await until(() => events.some((e) => e.type === "permission_request"));
  expect(await c.handle({ type: "send", sessionId, text })).toEqual({
    ok: true,
  });
  await until(() => idle(sessionId));
  expect(
    events.find((e) => e.type === "turn" && e.status === "idle"),
  ).toMatchObject({ stopCause: "aborted" });
  const history = await readFile(
    join(home, "sessions", `${sessionId}.jsonl`),
    "utf8",
  );
  expect(history).not.toContain(text);
  await c.shutdown();
});
it("exports an idle session through the host save dialog and handles cancellation", async () => {
  const output = join(home, "report.html");
  const saveReport = vi.fn(async () => output as string | undefined);
  const c = make(undefined, { saveReport });
  await c.init();
  const created = await c.handle({ type: "new_session", workspaceId: null });
  if (!created.ok || !created.sessionId)
    throw new Error("Session was not created");
  await c.handle({ type: "send", sessionId: created.sessionId, text: "hello" });
  await until(() => idle(created.sessionId!));
  expect(
    await c.handle({ type: "export_report", sessionId: created.sessionId }),
  ).toEqual({ ok: true });
  expect(saveReport).toHaveBeenCalledOnce();
  expect(await readFile(output, "utf8")).toContain("hello");
  saveReport.mockResolvedValueOnce(undefined);
  expect(
    await c.handle({ type: "export_report", sessionId: created.sessionId }),
  ).toEqual({ ok: false, error: "cancelled" });
  expect(
    await c.handle({ type: "export_report", sessionId: "missing" }),
  ).toEqual({ ok: false, error: "Unknown session" });
  await c.shutdown();
});
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
    // turn idle の後に索引を保存して state を送るため、state 自体の完了を待つ。
    await until(() => lastState().state.sessions[0]?.status === "idle");
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
    expect([...ro.keys()].sort()).toEqual([
      "AskUserQuestion",
      "Glob",
      "Grep",
      "Read",
      "StopTask",
    ]);
    expect([...ro.values()].every((t) => t.readOnly)).toBe(true);
  });
  it("rejects send for unknown sessions, double sends, unknown models, and a cancelled picker", async () => {
    const c = make();
    await c.init();
    expect(
      await c.handle({ type: "send", sessionId: "nope", text: "x" }),
    ).toMatchObject({ ok: false });
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

// ───────── レビュー指摘の修正(モデルのセッション別保持・cwd 確認・権限待ちの解放) ─────────
type Seen = { model: string; effort?: string };
class MultiModel extends FakeProvider {
  models() {
    return [
      "fake",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
    ].map((id) => ({ id, contextTokens: null }));
  }
}
function build(
  opts: { model?: string; effort?: "low" | "high"; warnings?: string[] } = {},
) {
  const seen: Seen[] = [];
  const controller = new SessionController({
    provider: new MultiModel({
      onRequest: (r) =>
        seen.push({ model: r.model, effort: r.reasoning?.effort }),
    }),
    model: opts.model ?? "claude-opus-5-5",
    effort: opts.effort,
    warnings: opts.warnings,
    home,
    fake: true,
    version: "1",
    host: { pickFolder: async () => workspace },
    emit: (e) => events.push(e),
    createTools: () => new Map([["Read", readTool]]),
    sleep: async () => undefined,
  });
  return { controller, seen };
}
const newId = async (c: SessionController, workspaceId: string | null = null) =>
  (
    (await c.handle({ type: "new_session", workspaceId })) as {
      sessionId: string;
    }
  ).sessionId;
const sessionOf = (id: string) =>
  lastState().state.sessions.find((s) => s.id === id)!;

describe("model and effort are kept per session", () => {
  it("new sessions start from the controller default", async () => {
    const { controller } = build({ model: "claude-sonnet-5-5", effort: "low" });
    await controller.init();
    const id = await newId(controller);
    expect(sessionOf(id)).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
    expect(lastState().state).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
  });
  it("set_model changes only that session and persists across a restart", async () => {
    const { controller, seen } = build();
    await controller.init();
    const a = await newId(controller);
    const b = await newId(controller);
    expect(
      await controller.handle({
        type: "set_model",
        sessionId: a,
        model: "sonnet",
        effort: "low",
      }),
    ).toMatchObject({ ok: true });
    expect(sessionOf(a)).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
    expect(sessionOf(b)).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
    });
    for (const id of [a, b]) {
      await controller.handle({ type: "send", sessionId: id, text: "hello" });
      await until(() => idle(id));
    }
    expect(seen).toEqual([
      { model: "claude-sonnet-5-5", effort: "low" },
      { model: "claude-opus-5-5", effort: "high" },
    ]);
    const { controller: again } = build();
    await again.init();
    await again.handle({ type: "ready" });
    expect(sessionOf(a)).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
    });
  });
  it("applies the change from the next round, not to the call in flight", async () => {
    const { controller, seen } = build();
    await controller.init();
    const id = await newId(controller);
    await controller.handle({
      type: "send",
      sessionId: id,
      text: "read a.txt",
    });
    await until(() => events.some((e) => e.type === "permission_request"));
    // 1周目(ツール呼び出しの権限待ち)の最中に切り替える
    await controller.handle({
      type: "set_model",
      sessionId: id,
      model: "haiku",
    });
    expect(seen).toHaveLength(1);
    const req = events.find((e) => e.type === "permission_request") as Extract<
      UiEvent,
      { type: "permission_request" }
    >;
    await controller.handle({
      type: "permission_response",
      sessionId: id,
      requestId: req.requestId,
      decision: "allow",
    });
    await until(() => idle(id));
    expect(seen.map((s) => s.model)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
    ]);
    // 実行中の set_model が、終了時の保存で巻き戻されない
    expect(sessionOf(id).model).toBe("claude-haiku-4-5-20251001");
  });
  it("rejects unknown sessions, unknown models and bad efforts", async () => {
    const { controller } = build();
    await controller.init();
    const id = await newId(controller);
    expect(
      await controller.handle({
        type: "set_model",
        sessionId: "nope",
        model: "opus",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await controller.handle({
        type: "set_model",
        sessionId: id,
        model: "gpt-x",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await controller.handle({
        type: "set_model",
        sessionId: id,
        model: "codex:sol",
      }),
    ).toMatchObject({ ok: false });
    expect(
      await controller.handle({
        type: "set_model",
        sessionId: id,
        model: "opus",
        effort: "turbo" as never,
      }),
    ).toMatchObject({ ok: false });
    expect(sessionOf(id).model).toBe("claude-opus-5-5");
  });
  it("fills in the default for sessions saved before models were stored", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, "sessions"), { recursive: true });
    await writeFile(
      join(home, "sessions", "index.json"),
      JSON.stringify([
        {
          id: "old",
          title: "old",
          workspaceId: null,
          cwd: workspace,
          readOnly: false,
          createdAt: 1,
          updatedAt: 1,
          providers: [],
        },
      ]),
    );
    const { controller } = build({ model: "claude-sonnet-5-5" });
    await controller.init();
    await controller.handle({ type: "ready" });
    expect(sessionOf("old")).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "high",
    });
  });
  it("reports startup warnings once, in the first new session", async () => {
    const { controller } = build({
      warnings: ["config.yaml の main.effort が不正です"],
    });
    await controller.init();
    await newId(controller);
    await newId(controller);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
  });
});

describe("working directory is checked when a session starts or resumes (§18.4)", () => {
  async function sessionInRemovableWorkspace() {
    const { rm } = await import("node:fs/promises");
    const gone = await mkdtemp(join(tmpdir(), "xh-gone-"));
    const { controller, seen } = build();
    await controller.init();
    const picked = (await controller.handle({ type: "pick_folder" })) as {
      workspaceId: string;
    };
    // pick_folder は共通の workspace を返すので、消せる別フォルダを登録し直す
    const c2 = new SessionController({
      provider: new MultiModel({
        onRequest: (r) => seen.push({ model: r.model }),
      }),
      model: "claude-opus-5-5",
      home,
      fake: true,
      version: "1",
      host: { pickFolder: async () => gone },
      emit: (e) => events.push(e),
      createTools: () => new Map([["Read", readTool]]),
    });
    await c2.init();
    const ws = (await c2.handle({ type: "pick_folder" })) as {
      workspaceId: string;
    };
    const id = await newId(c2, ws.workspaceId);
    void picked;
    return {
      c2,
      id,
      seen,
      gone,
      remove: () => rm(gone, { recursive: true, force: true }),
    };
  }
  it("does not call the model or run tools when the folder is gone, and says so", async () => {
    const { c2, id, seen, gone, remove } = await sessionInRemovableWorkspace();
    await remove();
    events.length = 0;
    const result = await c2.handle({
      type: "send",
      sessionId: id,
      text: "read a.txt",
    });
    expect(result).toMatchObject({ ok: false });
    expect(seen).toHaveLength(0);
    const err = events.find((e) => e.type === "error") as Extract<
      UiEvent,
      { type: "error" }
    >;
    expect(err.sessionId).toBe(id);
    expect(err.message).toContain("作業フォルダが見つかりません");
    expect(err.message).toContain(gone);
    expect(events.some((e) => e.type === "turn")).toBe(false);
    await c2.handle({ type: "ready" });
    expect(sessionOf(id).status).toBe("idle");
  });
  it("warns when a session is reopened after its folder was removed, but still shows the history", async () => {
    const { c2, id, remove } = await sessionInRemovableWorkspace();
    await c2.handle({ type: "send", sessionId: id, text: "hello" });
    await until(() => idle(id));
    await remove();
    events.length = 0;
    await c2.handle({ type: "open_session", sessionId: id });
    expect(events.find((e) => e.type === "transcript")).toBeTruthy();
    expect(JSON.stringify(events.filter((e) => e.type === "error"))).toContain(
      "作業フォルダが見つかりません",
    );
  });
  it("refuses to start a session in a workspace whose folder is gone", async () => {
    const { c2, id, remove } = await sessionInRemovableWorkspace();
    const wsId = lastState().state.sessions.find(
      (s) => s.id === id,
    )!.workspaceId!;
    await remove();
    const before = lastState().state.sessions.length;
    events.length = 0;
    expect(
      await c2.handle({ type: "new_session", workspaceId: wsId }),
    ).toMatchObject({ ok: false });
    expect(JSON.stringify(events)).toContain("作業フォルダが見つかりません");
    await c2.handle({ type: "ready" });
    expect(lastState().state.sessions.length).toBe(before);
  });
  it("treats a path that is a file, not a folder, as missing", async () => {
    const { c2, id, gone, remove } = await sessionInRemovableWorkspace();
    await remove();
    await writeFile(gone, "not a folder");
    events.length = 0;
    expect(
      await c2.handle({ type: "send", sessionId: id, text: "hi" }),
    ).toMatchObject({ ok: false });
    await (await import("node:fs/promises")).rm(gone, { force: true });
  });
});

describe("pending permissions are denied when a session closes or the app quits", () => {
  const permissionRequest = () =>
    events.find((e) => e.type === "permission_request") as
      Extract<UiEvent, { type: "permission_request" }> | undefined;
  async function waiting() {
    const { controller } = build();
    await controller.init();
    const id = await newId(controller);
    await controller.handle({
      type: "send",
      sessionId: id,
      text: "read a.txt",
    });
    await until(() => !!permissionRequest());
    return { controller, id };
  }
  it("close_session resolves the pending request as deny and ends the turn", async () => {
    const { controller, id } = await waiting();
    await controller.handle({ type: "close_session", sessionId: id });
    await until(() => idle(id));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "permission_resolved",
        decision: "deny",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "tool_result", isError: true }),
    );
    expect(lastState().state.currentSessionId).toBeNull();
    // 履歴は残り、一覧から消えない。閉じたあとも再開できる
    expect(sessionOf(id)).toBeTruthy();
    await controller.handle({ type: "open_session", sessionId: id });
    expect(lastState().state.currentSessionId).toBe(id);
  });
  it("shutdown denies every waiting session, finishes the turns, and saves history", async () => {
    const { controller, id } = await waiting();
    const other = await newId(controller);
    await controller.handle({
      type: "send",
      sessionId: other,
      text: "read b.txt",
    });
    await until(
      () => events.filter((e) => e.type === "permission_request").length === 2,
    );
    await controller.shutdown();
    expect(
      events.filter(
        (e) => e.type === "permission_resolved" && e.decision === "deny",
      ),
    ).toHaveLength(2);
    expect(idle(id)).toBe(true);
    expect(idle(other)).toBe(true);
    const stored = await readFile(
      join(home, "sessions", `${id}.jsonl`),
      "utf8",
    );
    // tool_use には対応する tool_result が必ず付いて保存される(次の呼び出しでエラーにならない)
    expect(stored).toContain("tool_result");
  });
  it("shutdown refuses new work afterwards and is safe with nothing running", async () => {
    const { controller } = build();
    await controller.init();
    const id = await newId(controller);
    await controller.shutdown();
    expect(
      await controller.handle({ type: "send", sessionId: id, text: "hi" }),
    ).toMatchObject({ ok: false });
    await controller.shutdown();
  });
  it("closing an idle session just forgets the runtime", async () => {
    const { controller } = build();
    await controller.init();
    const id = await newId(controller);
    expect(
      await controller.handle({ type: "close_session", sessionId: id }),
    ).toMatchObject({ ok: true });
    expect(
      await controller.handle({ type: "close_session", sessionId: "nope" }),
    ).toMatchObject({ ok: false });
  });
});

describe("send is safe against concurrent requests", () => {
  it("accepts only one of two simultaneous sends to the same session", async () => {
    const { controller, seen } = build();
    await controller.init();
    const id = await newId(controller);
    const results = await Promise.all([
      controller.handle({ type: "send", sessionId: id, text: "one" }),
      controller.handle({ type: "send", sessionId: id, text: "two" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      error: "Turn already running",
    });
    await until(() => idle(id));
    expect(seen).toHaveLength(1);
  });
  it("does not let a late history load overwrite a turn that already started", async () => {
    const { controller } = build();
    await controller.init();
    const id = await newId(controller);
    await controller.handle({ type: "send", sessionId: id, text: "first" });
    await until(() => idle(id));
    // 別の controller(=再起動後)で、未読み込みのセッションへ同時に送る
    events.length = 0;
    const { controller: again, seen } = build();
    await again.init();
    await Promise.all([
      again.handle({ type: "send", sessionId: id, text: "second" }),
      again.handle({ type: "send", sessionId: id, text: "third" }),
    ]);
    await until(() => idle(id));
    const stored = (
      await readFile(join(home, "sessions", `${id}.jsonl`), "utf8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { role: string });
    expect(stored.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(seen).toHaveLength(1);
  });
  it("reads a session's history once even when open and send race", async () => {
    const first = build();
    await first.controller.init();
    const id = await newId(first.controller);
    await first.controller.handle({
      type: "send",
      sessionId: id,
      text: "first",
    });
    await until(() => idle(id));
    // 再起動後: open_session の読み込みだけを遅らせ、その間に send が走る
    const original = SessionStore.prototype.messages;
    let calls = 0;
    const spy = vi
      .spyOn(SessionStore.prototype, "messages")
      .mockImplementation(async function (this: SessionStore, sid: string) {
        const result = await original.call(this, sid);
        if (calls++ === 0) await new Promise((r) => setTimeout(r, 200));
        return result;
      });
    try {
      events.length = 0;
      const lengths: number[] = [];
      const again = new SessionController({
        provider: new MultiModel({
          onRequest: (r) => lengths.push(r.messages.length),
        }),
        model: "claude-opus-5-5",
        home,
        fake: true,
        version: "1",
        host: { pickFolder: async () => workspace },
        emit: (e) => events.push(e),
        createTools: () => new Map(),
      });
      await again.init();
      const opening = again.handle({ type: "open_session", sessionId: id });
      await again.handle({ type: "send", sessionId: id, text: "second" });
      await opening;
      await until(() => idle(id));
      events.length = 0;
      await again.handle({ type: "send", sessionId: id, text: "third" });
      await until(() => idle(id));
      // 2回目の要求は、過去4件 + 新しい発言 = 5件を含む(遅れた読み込みで履歴が巻き戻らない)
      expect(lengths).toEqual([3, 5]);
      expect(calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("releases the reservation when the folder is missing, so a later send works", async () => {
    const { rm, mkdir: mk } = await import("node:fs/promises");
    const { controller } = build();
    await controller.init();
    const id = await newId(controller);
    const cwd = lastState().state.sessions.find((s) => s.id === id)!.cwd;
    await rm(cwd, { recursive: true, force: true });
    expect(
      await controller.handle({ type: "send", sessionId: id, text: "x" }),
    ).toMatchObject({ ok: false });
    await mk(cwd, { recursive: true });
    expect(
      await controller.handle({ type: "send", sessionId: id, text: "y" }),
    ).toMatchObject({ ok: true });
    await until(() => idle(id));
  });
  it("tells the user when a corrupt index was moved aside", async () => {
    const { mkdir: mk } = await import("node:fs/promises");
    await mk(join(home, "sessions"), { recursive: true });
    await writeFile(join(home, "sessions", "index.json"), "{broken");
    const { controller } = build();
    await controller.init();
    await newId(controller);
    expect(JSON.stringify(events.filter((e) => e.type === "error"))).toContain(
      "退避",
    );
  });
});
