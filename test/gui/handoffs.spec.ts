import { test, expect } from "./electron.fixture.js";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("fake result delivery previews, confirms once and displays untrusted inbox after reload without execution", async ({
  gui,
  electronApp,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "xh-handoff-gui-"));
  try {
    const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
    await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, root);
    const picked = await gui.evaluate(() =>
      window.harness.command({ type: "pick_folder" }),
    );
    if (!picked.ok || !picked.workspaceId) throw new Error("workspace");
    const source = await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    const dest = await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    if (!source.ok || !source.sessionId || !dest.ok || !dest.sessionId)
      throw new Error("sessions");
    await gui.evaluate(
      (sessionId) =>
        window.harness.command({ type: "open_session", sessionId }),
      source.sessionId,
    );
    const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
    await prompt.fill("ping");
    await prompt.press("Enter");
    await expect(gui.getByText("pong", { exact: true })).toBeVisible();
    await expect(prompt).toBeEnabled();
    await gui
      .getByRole("button", { name: "結果の受け渡し", exact: true })
      .click();
    const panel = gui.getByRole("dialog", { name: "結果の受け渡し" });
    await panel
      .getByRole("combobox", { name: "宛先会話" })
      .selectOption(dest.sessionId);
    await panel
      .getByRole("button", { name: "送信プレビュー", exact: true })
      .click();
    await expect(
      panel.getByText("未送信の確認票（60秒）", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "明示送信", exact: true }),
    ).toBeDisabled();
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "明示送信", exact: true }).click();
    await expect(
      panel.getByText("送信・受信確定 · モデル未実行", { exact: true }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "閉じる", exact: true }).click();
    await gui.evaluate(
      (sessionId) =>
        window.harness.command({ type: "open_session", sessionId }),
      dest.sessionId,
    );
    await gui.reload();
    await gui
      .getByRole("button", { name: "結果の受け渡し", exact: true })
      .click();
    await expect(
      panel.getByText("受信済み · モデル未実行", { exact: true }),
    ).toBeVisible();
    await panel.getByText("未信頼の参照本文と出典", { exact: true }).click();
    await expect(panel).toContainText("Untrusted task-result reference");
    await expect(panel).toContainText(source.sessionId);
    await expect(panel).toContainText("pong");
    expect(
      JSON.parse(await readFile(join(home, "handoffs.json"), "utf8")),
    ).toHaveLength(1);
    await expect(
      readFile(join(home, "sessions", `${dest.sessionId}.jsonl`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await gui.screenshot({
      path: info.outputPath("handoff-inbox.png"),
      fullPage: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
