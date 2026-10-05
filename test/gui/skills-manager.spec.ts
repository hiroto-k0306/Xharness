import { test, expect } from "./electron.fixture.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
test("manager distinguishes preview from actual load and invalidates selection after updates and deletion", async ({
  gui,
  electronApp,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "xh-skills-manager-"));
  const path = join(root, ".agents/skills/example/SKILL.md");
  const text = (body: string) =>
    `---\nname: example\ndescription: Local recipe\n---\n${body}\n`;
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text("PREVIEW BODY"));
    await mkdir(join(root, ".agents/skills/invalid"));
    await writeFile(
      join(root, ".agents/skills/invalid/SKILL.md"),
      "---\nname: invalid\n---\nMissing description\n",
    );
    for (let i = 0; i < 35; i++) {
      const folder = join(root, ".agents/skills", `item-${i}`);
      await mkdir(folder);
      await writeFile(
        join(folder, "SKILL.md"),
        `---\nname: item-${i}\ndescription: Other recipe\n---\nfixture\n`,
      );
    }
    const panel = await setup(gui, electronApp, root);
    const allow = async (name: string) => {
      const p = panel.getByRole("alertdialog", { name: `${name} の実行確認` });
      await expect(p).toBeVisible();
      await p.getByRole("button", { name: /allow/ }).click();
    };
    await panel.getByRole("button", { name: "一覧を取得・更新" }).click();
    await allow("ListProjectSkills");
    await expect(panel).toContainText("36件取得");
    await expect(panel).toContainText('"invalid_metadata":1');
    await panel
      .getByRole("textbox", { name: "スキル一覧を検索" })
      .fill("example");
    const item = panel
      .getByRole("list", { name: "スキル一覧" })
      .getByRole("button");
    await expect(item).toHaveCount(1);
    await item.click();
    const load = panel.getByRole("button", { name: "会話でこの版を読み込む" });
    await expect(load).toBeDisabled();
    await panel.getByRole("button", { name: "この版をプレビュー" }).click();
    await allow("LoadProjectSkill");
    await expect(panel.getByLabel("スキル本文プレビュー")).toContainText(
      "PREVIEW BODY",
    );
    await expect(panel).not.toContainText("会話に読込済み");
    await load.click();
    await allow("LoadProjectSkill");
    await expect(item).toContainText("会話に読込済み（この版）");
    await expect(
      panel.getByRole("button", { name: "一覧を取得・更新" }),
    ).toBeEnabled();
    await writeFile(path, text("UPDATED BODY"));
    await panel.getByRole("button", { name: "一覧を取得・更新" }).click();
    await allow("ListProjectSkills");
    await expect(panel.getByRole("alert")).toContainText("再選択");
    await expect(item).toContainText("会話は旧版・更新あり");
    await item.click();
    await panel.getByRole("button", { name: "この版をプレビュー" }).click();
    await allow("LoadProjectSkill");
    await expect(panel.getByLabel("スキル本文プレビュー")).toContainText(
      "UPDATED BODY",
    );
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.setMinimumSize(0, 0);
      window.setSize(580, 800);
    });
    expect(await panel.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    await gui.screenshot({ path: info.outputPath("manager-narrow.png") });
    await rm(path);
    await load.click();
    await allow("LoadProjectSkill");
    await expect(panel.getByRole("alert")).toContainText("読込結果");
    await expect(load).toBeDisabled();
    await panel.getByRole("button", { name: "一覧を取得・更新" }).click();
    await allow("ListProjectSkills");
    await expect(item).toHaveCount(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
