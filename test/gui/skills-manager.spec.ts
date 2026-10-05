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
test("task suggestions use permitted metadata, cap results and invalidate old choices without automatic loading", async ({
  gui,
  electronApp,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "xh-skill-suggestions-"));
  const path = join(root, ".agents/skills/review-0/SKILL.md");
  const text = (body: string) =>
    `---\nname: review-0\ndescription: 品質レビュー\n---\n${body}\n`;
  try {
    for (let i = 0; i < 6; i++) {
      const folder = join(root, ".agents/skills", `review-${i}`);
      await mkdir(folder, { recursive: true });
      await writeFile(
        join(folder, "SKILL.md"),
        `---\nname: review-${i}\ndescription: 品質レビュー\n---\nDo not use this body to select cache candidates.\n`,
      );
    }
    await gui
      .getByRole("textbox", { name: "prompt", exact: true })
      .fill("Please review quality");
    const panel = await setup(gui, electronApp, root);
    const suggestions = panel.getByRole("region", {
      name: "依頼に関連するスキル候補",
    });
    const request = suggestions.getByRole("textbox", {
      name: "候補を探す依頼内容",
    });
    const candidates = suggestions
      .getByRole("list", { name: "スキル候補" })
      .getByRole("button");
    await suggestions
      .getByRole("button", { name: "入力中の依頼を使う（先頭500文字）" })
      .click();
    await expect(request).toHaveValue("Please review quality");
    await expect(candidates).toHaveCount(0);
    const permission = (name: string) =>
      panel.getByRole("alertdialog", { name: `${name} の実行確認` });
    const allow = async (name: string) => {
      await expect(permission(name)).toBeVisible();
      await permission(name).getByRole("button", { name: /allow/ }).click();
    };
    const refresh = panel.getByRole("button", { name: "一覧を取得・更新" });
    await refresh.click();
    await permission("ListProjectSkills")
      .getByRole("button", { name: /deny/ })
      .click();
    await expect(candidates).toHaveCount(0);
    await refresh.click();
    await panel.getByRole("button", { name: "読取を取消" }).click();
    await expect(candidates).toHaveCount(0);
    await refresh.click();
    await allow("ListProjectSkills");
    await expect(candidates).toHaveCount(3);
    await expect(suggestions).toContainText("他3件は表示を省略");
    await expect(suggestions).toContainText("名前の語一致");
    await request.fill("cache");
    await expect(candidates).toHaveCount(0); // matching text exists only in the body
    await expect(suggestions).toContainText("語が一致する候補はありません");
    await request.fill("品質をレビューしてください");
    await expect(candidates).toHaveCount(3);
    await expect(suggestions).toContainText("説明の語一致");
    await candidates.first().evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(panel.getByRole("alertdialog")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "会話でこの版を読み込む" }),
    ).toBeDisabled();
    await panel.getByRole("button", { name: "この版をプレビュー" }).click();
    await allow("LoadProjectSkill");
    const load = panel.getByRole("button", { name: "会話でこの版を読み込む" });
    await expect(load).toBeEnabled();
    await request.fill("cache");
    await expect(load).toHaveCount(0); // changed task cannot retain the old selection/preview
    await request.fill("review");
    await candidates.first().click();
    await writeFile(path, text("UPDATED PREVIEW"));
    await panel.getByRole("button", { name: "この版をプレビュー" }).click();
    await allow("LoadProjectSkill");
    await expect(panel.getByRole("alert")).toContainText("再取得");
    await expect(load).toBeDisabled();
    await expect(candidates).toHaveCount(0);
    await refresh.click();
    await expect(candidates).toHaveCount(0);
    await panel.getByRole("button", { name: "読取を取消" }).click();
    await expect(candidates).toHaveCount(0); // stale snapshot is not re-used after cancellation
    await refresh.click();
    await allow("ListProjectSkills");
    await candidates.first().click();
    await panel.getByRole("button", { name: "この版をプレビュー" }).click();
    await allow("LoadProjectSkill");
    await expect(panel.getByLabel("スキル本文プレビュー")).toContainText(
      "UPDATED PREVIEW",
    );
    await expect(panel).not.toContainText("会話に読込済み");
    await load.click();
    await allow("LoadProjectSkill");
    await expect(panel.getByRole("list", { name: "スキル一覧" })).toContainText(
      "会話に読込済み（この版）",
    );
    await expect(refresh).toBeEnabled();
    await expect(candidates).toHaveCount(3);
    await gui.screenshot({ path: info.outputPath("suggestions.png") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("linked Japanese documents require separate inspection, preview and explicit conversation load", async ({
  gui,
  electronApp,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "xh-reference-ui-"));
  const source = ".agents/skills/example/references/日本語 手順.md";
  const path = join(root, source);
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      join(root, ".agents/skills/example/SKILL.md"),
      "---\nname: example\ndescription: References demo\n---\n[手順](<references/日本語 手順.md>)\n[script](install.ps1)\n",
    );
    await writeFile(path, "DOCUMENT ONLY BODY");
    const panel = await setup(gui, electronApp, root);
    const permission = () =>
      panel.getByRole("alertdialog", { name: "LoadProjectSkill の実行確認" });
    const allow = async () => {
      await expect(permission()).toBeVisible();
      await permission().getByRole("button", { name: /allow/ }).click();
    };
    await panel.getByRole("button", { name: "一覧を取得・更新" }).click();
    await panel
      .getByRole("alertdialog")
      .getByRole("button", { name: /allow/ })
      .click();
    await panel
      .getByRole("list", { name: "スキル一覧" })
      .getByRole("button")
      .click();
    const parentPreview = panel.getByRole("button", {
      name: "この版をプレビュー",
      exact: true,
    });
    await parentPreview.click();
    await allow();
    const refs = panel.getByRole("region", { name: "スキル付属資料" });
    const inspect = panel.getByRole("button", {
      name: `資料の版を確認: ${source}`,
      exact: true,
    });
    await expect(inspect).toBeVisible();
    await expect(panel).not.toContainText("DOCUMENT ONLY BODY");
    await inspect.click();
    await permission().getByRole("button", { name: /deny/ }).click();
    await expect(panel.getByRole("alert")).toContainText("拒否");
    await parentPreview.click();
    await allow();
    await inspect.click();
    await expect(permission()).toBeVisible();
    await panel.getByRole("button", { name: "読取を取消" }).click();
    await expect(permission()).toHaveCount(0);
    await inspect.evaluate((e) => {
      (e as HTMLButtonElement).click();
      (e as HTMLButtonElement).click();
    });
    await allow();
    await expect(refs).toContainText("資料SHA-256");
    await expect(panel).not.toContainText("DOCUMENT ONLY BODY");
    const preview = panel.getByRole("button", {
      name: "資料をプレビュー",
      exact: true,
    });
    const load = panel.getByRole("button", {
      name: "会話でこの資料の版を読み込む",
      exact: true,
    });
    await expect(load).toBeDisabled();
    await preview.click();
    await allow();
    await expect(panel.getByLabel("付属資料本文プレビュー")).toContainText(
      "DOCUMENT ONLY BODY",
    );
    await expect(panel).not.toContainText("会話に資料読込済み");
    await writeFile(path, "DOCUMENT UPDATED BODY");
    await load.click();
    await allow();
    await expect(panel.getByRole("alert")).toContainText("読込結果");
    await expect(panel).not.toContainText("会話に資料読込済み");
    await parentPreview.click();
    await allow();
    await inspect.click();
    await allow();
    await preview.click();
    await allow();
    await expect(panel.getByLabel("付属資料本文プレビュー")).toContainText(
      "DOCUMENT UPDATED BODY",
    );
    await load.click();
    await allow();
    await expect(refs).toContainText("会話に資料読込済み（親と資料のこの版）");
    await expect(
      panel.getByRole("list", { name: "スキル一覧" }),
    ).not.toContainText("会話に読込済み（この版）");
    await expect(
      panel.getByRole("button", { name: "一覧を取得・更新" }),
    ).toBeEnabled();
    await panel.getByLabel("付属資料本文プレビュー").scrollIntoViewIfNeeded();
    await gui.screenshot({ path: info.outputPath("references.png") });
    await rm(path);
    await preview.click();
    await allow();
    await expect(panel.getByRole("alert")).toContainText("再取得");
    await expect(load).toHaveCount(0);
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
