import { test, expect } from "./electron.fixture.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
async function setup(
  gui: import("@playwright/test").Page,
  app: import("@playwright/test").ElectronApplication,
  root: string,
) {
  const home = await app.evaluate(() => process.env.XHARNESS_HOME!);
  await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, root);
  const picked = await gui.evaluate(() =>
    window.harness.command({ type: "pick_folder" }),
  );
  if (!picked.ok || !picked.workspaceId) throw new Error("Workspace missing");
  await gui.evaluate(
    (workspaceId) =>
      window.harness.command({ type: "new_session", workspaceId }),
    picked.workspaceId,
  );
  await gui.getByRole("button", { name: "スキル管理", exact: true }).click();
  return gui.getByRole("dialog", {
    name: "プロジェクトスキル管理",
    exact: true,
  });
}
test("empty manager handles denial, typing, cancellation, escape and narrow-window focus", async ({
  gui,
  electronApp,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "xh-skills-manager-empty-"));
  try {
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setMinimumSize(0, 0); // exercise the dialog's responsive layout below app minimum
      window.setSize(520, 760);
    });
    const panel = await setup(gui, electronApp, root);
    await panel.getByRole("button", { name: "一覧を取得・更新" }).click();
    const permission = panel.getByRole("alertdialog", {
      name: "ListProjectSkills の実行確認",
    });
    await expect(permission).toBeVisible();
    await panel
      .getByRole("textbox", { name: "スキル一覧を検索" })
      .pressSequentially("any");
    await expect(permission).toBeVisible(); // typing cannot grant the global a/y shortcuts
    await permission.getByRole("button", { name: /deny/ }).click();
    await expect(panel.getByRole("alert")).toContainText("拒否");
    await panel.getByRole("button", { name: "一覧を取得・更新" }).click();
    await expect(permission).toBeVisible();
    await panel.getByRole("button", { name: "読取を取消" }).click();
    await expect(permission).toHaveCount(0);
    await panel.getByRole("button", { name: "一覧を取得・更新" }).click();
    await expect(permission).toBeVisible();
    await permission.getByRole("button", { name: /allow/ }).click();
    await expect(panel).toContainText("利用できるスキルがありません");
    await expect(panel).toContainText(".agents/skills/<名前>/SKILL.md");
    expect(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    await gui.screenshot({ path: info.outputPath("empty-narrow.png") });
    await gui.keyboard.press("Escape");
    await expect(panel).not.toBeVisible();
    await expect(
      gui.getByRole("button", { name: "スキル管理", exact: true }),
    ).toBeFocused();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
