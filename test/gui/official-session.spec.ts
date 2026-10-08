import { test, expect } from "./electron.fixture.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("ordinary fake questions finish once, persist public evidence and survive reload", async ({
  gui,
  electronApp,
}) => {
  const made = await gui.evaluate(() =>
    window.harness.command({ type: "new_session", workspaceId: null }),
  );
  if (!made.ok || !made.sessionId) throw Error("session");
  const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
  for (const [index, question] of [
    "こんにちは",
    "もう少し説明して",
    "ありがとう",
  ].entries()) {
    await prompt.fill(question);
    await prompt.press("Enter");
    await expect(
      gui.getByText("模擬回答：計画・実装は開始していません。", {
        exact: true,
      }),
    ).toHaveCount(index + 1);
    await expect(prompt).toBeEnabled();
  }
  const state = await gui.evaluate(() =>
    window.harness.officialWorkflow!({ action: "list" }),
  );
  expect(state.activeId).toBeUndefined();
  expect(state.records).toHaveLength(3);
  for (const { record } of state.records) {
    expect(record.status).toBe("completed");
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]!.phase).toBe("conversation");
    expect(record.plan).toBeUndefined();
    expect(record.calls[0]!.communication?.events).toEqual([
      expect.objectContaining({
        actor: "harness",
        kind: "end",
        status: "completed",
      }),
    ]);
  }
  const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
  const history = await readFile(
    join(home, "sessions", `${made.sessionId}.jsonl`),
    "utf8",
  );
  expect(history).toContain("模擬回答：計画・実装は開始していません。");
  await gui.reload();
  await expect(
    gui.getByText("模擬回答：計画・実装は開始していません。", { exact: true }),
  ).toHaveCount(3);
  const restored = await gui.evaluate(() =>
    window.harness.officialWorkflow!({ action: "list" }),
  );
  expect(restored.records.map((r) => r.record.calls)).toEqual(
    state.records.map((r) => r.record.calls),
  );
  expect(
    await readFile(join(home, "sessions", `${made.sessionId}.jsonl`), "utf8"),
  ).toBe(history);
});
