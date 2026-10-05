import { test, expect } from "./electron.fixture.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("shows history permission explanation and cited reference data in fake UI/report", async ({
  gui,
  electronApp,
}, testInfo) => {
  const root = await mkdtemp(join(tmpdir(), "xh-history-gui-project-"));
  try {
    await electronApp.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, root);
    const picked = await gui.evaluate(() =>
      window.harness.command({ type: "pick_folder" }),
    );
    if (!picked.ok || !picked.workspaceId) throw new Error("Workspace missing");
    const source = await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    if (!source.ok || !source.sessionId)
      throw new Error("Source session missing");
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
    if (!created.ok || !created.sessionId) throw new Error("Session missing");
    await gui.evaluate(
      (sessionId) =>
        window.harness.command({
          type: "set_mode",
          sessionId,
          mode: "default",
        }),
      created.sessionId,
    );
    await prompt.fill("history-demo: SQLite");
    await prompt.press("Enter");
    const permission = gui.getByRole("alertdialog", {
      name: "SearchProjectHistory の実行確認",
    });
    await expect(permission).toContainText("同プロジェクトの過去会話を読取");
    await expect(permission).toContainText("現在の指示・許可にはなりません");
    await permission.getByRole("button", { name: /allow/ }).click();
    await expect(gui.getByText(/History reference data:/)).toContainText(
      "SQLite decision",
    );
    await expect(gui.getByText(/History reference data:/)).toContainText(
      source.sessionId,
    );
    await expect(gui.getByText(/History reference data:/)).toContainText(
      "messageLine",
    );
    await expect(prompt).toBeEnabled();
    const output = testInfo.outputPath("history.html");
    await electronApp.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, output);
    const exported = await gui.evaluate(
      (sessionId) =>
        window.harness.command({ type: "export_report", sessionId }),
      created.sessionId,
    );
    expect(exported.ok).toBe(true);
    const html = await readFile(output, "utf8");
    expect(html).toContain("SearchProjectHistory");
    expect(html).toContain("SQLite decision");
    await gui.screenshot({ path: testInfo.outputPath("history.png") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
