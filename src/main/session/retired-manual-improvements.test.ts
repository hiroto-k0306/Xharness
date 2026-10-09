import { expect, it } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommand, type HarnessCommand } from "../../shared/ipc.js";
import { fixture } from "./official-session.fixture.js";

it("rejects every retired manual comparison entry without touching saved data or dispatching a model", async () => {
  const f = await fixture();
  const folder = join(f.root, ".xharness");
  await mkdir(folder);
  const paths = [
    join(f.home, "improvements.json"),
    join(folder, "improvements.json"),
  ];
  const saved = '{"legacy":"preserve bytes and unknown schema"}\n';
  for (const path of paths) await writeFile(path, saved);
  for (const action of [
    "list",
    "cancel",
    "create",
    "candidate",
    "prepare",
    "record",
    "adopt",
    "restore",
    "model_candidates",
    "select_model_candidate",
  ]) {
    const command = {
      type: "improvements",
      sessionId: f.sessionId,
      operationId: "stale-ui",
      request: { action },
    };
    expect(parseCommand(command)).toBeUndefined();
    const result = await f.c.handle(command as unknown as HarnessCommand);
    expect(result).toEqual({
      ok: false,
      error:
        "手動改善版の比較・採用機能は廃止されました。既存の比較データは変更していません。",
    });
  }
  for (const path of paths) expect(await readFile(path, "utf8")).toBe(saved);
  expect(f.requests).not.toHaveBeenCalled();
  expect(
    (await f.c.state()).sessions.find((s) => s.id === f.sessionId)?.status,
  ).toBe("idle");
});
