import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  mkdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { FileAccess, fileTools } from "../tools/files.js";
import { SessionStore } from "./store.js";
import { type UiEvent } from "../../shared/ipc.js";

it("tracks real Write calls, previews locally, cancels safely, and rewinds both without LLM communication", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-undo-controller-"));
  await writeFile(join(home, "config.yaml"), "workflow:\n  mode: off\n");
  await mkdir(join(home, "checkpoints", "broken", "turn"), { recursive: true });
  await writeFile(
    join(home, "checkpoints", "broken", "turn", "turn.json"),
    "broken",
  );
  await mkdir(join(home, "checkpoints", "invalid name"));
  await symlink(
    join(home, "scratch"),
    join(home, "checkpoints", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const events: UiEvent[] = [];
  const request = vi.fn();
  const controller = new SessionController({
    home,
    fake: true,
    version: "test",
    model: "fake",
    provider: new FakeProvider({
      onRequest: request,
      script: [
        {
          type: "message",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "w",
                name: "Write",
                input: { path: "new.txt", content: "created" },
              },
            ],
          },
        },
        {
          type: "message",
          stopReason: "end_turn",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "完了" }],
          },
        },
      ],
    }),
    host: { pickFolder: async () => undefined },
    emit: (event) => events.push(event),
    createTools: (cwd) => fileTools(new FileAccess(cwd)),
  });
  await controller.init();
  const created = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!created.ok || !created.sessionId) throw new Error("Session not created");
  const sessionId = created.sessionId;
  const path = join(home, "scratch", sessionId, "new.txt");
  const idle = async () =>
    vi.waitFor(
      () =>
        expect(
          events.some((e) => e.type === "turn" && e.status === "idle"),
        ).toBe(true),
      { timeout: 5000 },
    );
  expect(
    await controller.handle({
      type: "send",
      sessionId,
      text: "ファイルを作成",
    }),
  ).toMatchObject({ ok: true });
  await vi.waitFor(
    () =>
      expect(events.some((e) => e.type === "permission_request")).toBe(true),
    { timeout: 5000 },
  );
  const permission = events.find(
    (e) => e.type === "permission_request",
  )! as Extract<UiEvent, { type: "permission_request" }>;
  await controller.handle({
    type: "permission_response",
    sessionId,
    requestId: permission.requestId,
    decision: "allow",
  });
  await idle();
  expect(await readFile(path, "utf8")).toBe("created");
  expect(await readdir(join(home, "checkpoints", sessionId))).toHaveLength(1);
  const calls = request.mock.calls.length;
  const preview = async () => {
    events.length = 0;
    expect(
      await controller.handle({ type: "send", sessionId, text: "/undo" }),
    ).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "rewind_request")).toBe(true),
    );
    return events.find((e) => e.type === "rewind_request")! as Extract<
      UiEvent,
      { type: "rewind_request" }
    >;
  };
  const cancelled = await preview();
  expect(cancelled.preview.files).toHaveLength(1);
  events.length = 0;
  await controller.handle({ type: "ready" });
  expect(events.find((e) => e.type === "rewind_request")).toEqual(cancelled);
  expect(await readFile(path, "utf8")).toBe("created");
  expect(request).toHaveBeenCalledTimes(calls);
  expect(
    await controller.handle({
      type: "rewind_response",
      sessionId,
      requestId: "stale",
      choice: null,
    }),
  ).toMatchObject({ ok: false });
  await controller.handle({
    type: "rewind_response",
    sessionId,
    requestId: cancelled.requestId,
    choice: null,
  });
  await idle();
  expect(await readFile(path, "utf8")).toBe("created");
  const approved = await preview();
  await controller.handle({
    type: "rewind_response",
    sessionId,
    requestId: approved.requestId,
    choice: { scope: "both", includeConflicts: [] },
  });
  await idle();
  expect(request).toHaveBeenCalledTimes(calls);
  await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  const store = new SessionStore(home);
  const active = await store.messages(sessionId);
  expect(active).toHaveLength(1);
  expect(active[0]!.meta?.rewind).toEqual({ keep: 0 });
  expect(
    await readFile(join(home, "sessions", sessionId + ".jsonl"), "utf8"),
  ).toContain("ファイルを作成");
  expect(
    events.some((e) => e.type === "receipt" && e.receipt.tool === "Rewind"),
  ).toBe(true);
  expect(
    await controller.handle({
      type: "delete_session",
      sessionId,
      confirmed: false,
    }),
  ).toMatchObject({ ok: false });
  await controller.handle({
    type: "delete_session",
    sessionId,
    confirmed: true,
  });
  await expect(
    readdir(join(home, "checkpoints", sessionId)),
  ).rejects.toMatchObject({ code: "ENOENT" });
  await controller.shutdown();
});
