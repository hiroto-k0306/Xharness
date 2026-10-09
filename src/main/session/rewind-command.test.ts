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
import { FileCheckpointStore } from "../checkpoints/store.js";
import { SessionStore } from "./store.js";
import { type UiEvent } from "../../shared/ipc.js";

it("rejects retired undo without changing historical checkpoints, files or conversation", async () => {
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
    model: "claude:opus",
    officialSession: async () => {
      request();
      return { workflowId: "unused", status: "completed", summary: "unused" };
    },
    provider: new FakeProvider({
      onRequest: request,
    }),
    host: { pickFolder: async () => undefined },
    emit: (event) => events.push(event),
  });
  await controller.init();
  const created = await controller.handle({
    type: "new_session",
    workspaceId: null,
  });
  if (!created.ok || !created.sessionId) throw new Error("Session not created");
  const sessionId = created.sessionId;
  const path = join(home, "scratch", sessionId, "new.txt");
  const sessionStore = new SessionStore(home);
  await sessionStore.load();
  await sessionStore.append(
    sessionId,
    [{ role: "user", content: [{ type: "text", text: "ファイルを作成" }] }],
    (s) => s,
  );
  const checkpoints = new FileCheckpointStore(home);
  const hooks = await checkpoints.begin(
    sessionId,
    join(home, "scratch", sessionId),
    0,
    (s) => s,
    vi.fn(),
  );
  await hooks.beforeWrite(path);
  await writeFile(path, "created");
  await hooks.afterWrite(path, Buffer.from("created"));
  expect(await readFile(path, "utf8")).toBe("created");
  expect(await readdir(join(home, "checkpoints", sessionId))).toHaveLength(1);
  const historyPath = join(home, "sessions", sessionId + ".jsonl");
  const historyBefore = await readFile(historyPath);
  const checkpointsBefore = await readdir(join(home, "checkpoints", sessionId));
  const restore = vi.spyOn(FileCheckpointStore.prototype, "restore");
  const plan = await checkpoints.preview(sessionId, 1);
  expect(plan.preview.files).toHaveLength(1);
  expect(plan.preview.files[0]).toMatchObject({ conflict: false });
  for (const text of ["/undo", "/rewind 1"]) {
    expect(
      await controller.handle({ type: "send", sessionId, text }),
    ).toMatchObject({ ok: false });
  }
  expect(
    await controller.handle({
      type: "rewind_response",
      sessionId,
      requestId: "stale",
      choice: { scope: "both", includeConflicts: [] },
    }),
  ).toMatchObject({ ok: false });
  await controller.handle({ type: "ready" });
  expect(events.some((event) => event.type === "rewind_request")).toBe(false);
  expect(request).not.toHaveBeenCalled();
  expect(restore).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe("created");
  expect(await readFile(historyPath)).toEqual(historyBefore);
  expect(await readdir(join(home, "checkpoints", sessionId))).toEqual(
    checkpointsBefore,
  );
  expect(await sessionStore.messages(sessionId)).toHaveLength(1);
  restore.mockRestore();
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
