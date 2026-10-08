import { test, expect } from "../../gui/electron.fixture.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("fake proposal is reviewed and edited before retrieval in a new task", async ({
  gui,
  electronApp,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "xh-memory-gui-"));
  try {
    const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
    await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
    await electronApp.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, root);
    const picked = await gui.evaluate(() =>
      window.harness.command({ type: "pick_folder" }),
    );
    if (!picked.ok || !picked.workspaceId) throw new Error("Missing project");
    const source = await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    if (!source.ok || !source.sessionId) throw new Error("Missing source");
    const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
    await prompt.fill("SQLite decision");
    await prompt.press("Enter");
    await expect(gui.getByText("pong", { exact: true })).toBeVisible();
    await expect(prompt).toBeEnabled();
    const created = await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    if (!created.ok || !created.sessionId) throw new Error("Missing task");
    await prompt.fill(`memory-demo: ${source.sessionId}/1`);
    await prompt.press("Enter");
    const permission = gui.getByRole("alertdialog", {
      name: "ProposeProjectMemory の実行確認",
    });
    await expect(permission).toContainText("候補の保存のみ");
    await permission.getByRole("button", { name: /allow/ }).click();
    await expect(
      gui.getByText("Memory candidate saved for user review", { exact: true }),
    ).toBeVisible();
    await expect(prompt).toBeEnabled();
    const panel = gui.getByRole("dialog", { name: "プロジェクトメモリ" });
    await expect(panel).toBeVisible();
    const entry = panel.locator("article").first();
    await expect(entry).toContainText("candidate");
    await expect(entry).toContainText(source.sessionId);
    await expect(entry).toContainText("行1");
    await entry.getByRole("button", { name: "確認・編集" }).click();
    await panel
      .getByRole("textbox", { name: "メモリの内容", exact: true })
      .fill("User reviewed SQLite recipe");
    await panel
      .getByRole("button", { name: "編集内容で採用", exact: true })
      .click();
    await expect(entry).toContainText("accepted");
    await expect(entry).toContainText("User reviewed SQLite recipe");
    await gui.screenshot({ path: testInfo.outputPath("accepted-memory.png") });
    await panel.getByRole("button", { name: "閉じる", exact: true }).click();
    await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    await prompt.fill("memory-search: SQLite");
    await prompt.press("Enter");
    const search = gui.getByRole("alertdialog", {
      name: "SearchProjectMemory の実行確認",
    });
    await search.getByRole("button", { name: /allow/ }).click();
    await expect(gui.getByText(/Memory reference result:/)).toContainText(
      "User reviewed SQLite recipe",
    );
    await expect(gui.getByText(/Memory reference result:/)).toContainText(
      source.sessionId,
    );
    await expect(gui.getByText(/Memory reference result:/)).toContainText(
      "untrusted",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
