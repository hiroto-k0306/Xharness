import { test, expect } from "./electron.fixture.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("fixed fake evaluations require explicit quality and support candidate adoption and persistent restoration", async ({
  gui,
  electronApp,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "xh-improvement-gui-"));
  try {
    const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
    await writeFile(join(home, "config.yaml"), "workflow: {mode: off}\n");
    await mkdir(join(root, ".agents"));
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
    await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    const panel = gui.getByRole("dialog", { name: "改善版の比較" });
    await gui
      .getByRole("button", { name: "改善版の比較", exact: true })
      .click();
    await panel.getByRole("textbox", { name: "比較名" }).fill("固定改善課題");
    await panel
      .getByRole("textbox", { name: "基準本文" })
      .fill("Reply concisely");
    await panel.getByRole("button", { name: "基準版を保存" }).click();
    await panel
      .getByRole("combobox", { name: "比較を選択" })
      .selectOption({ label: "固定改善課題" });
    await panel
      .getByRole("textbox", { name: "切替理由" })
      .fill("Unmeasured must fail");
    await panel.getByRole("checkbox", { name: "操作を明示確認" }).check();
    await panel.getByRole("button", { name: "選択版を採用" }).click();
    await expect(panel.getByRole("alert")).toContainText("全固定課題");
    const evaluate = async (label: string) => {
      await panel
        .getByRole("combobox", { name: "対象版" })
        .selectOption({ label });
      await panel
        .getByRole("button", { name: "評価依頼を準備（通信なし）" })
        .click();
      await expect(
        panel.getByRole("textbox", { name: "固定評価依頼" }),
      ).toContainText("XHarness fixed evaluation");
      await panel.getByRole("checkbox", { name: "操作を明示確認" }).check();
      await panel.getByRole("button", { name: "新規会話で評価実行" }).click();
      await expect(
        gui.getByRole("textbox", { name: "prompt", exact: true }),
      ).toBeEnabled();
      await gui
        .getByRole("button", { name: "改善版の比較", exact: true })
        .click();
      await panel
        .getByRole("combobox", { name: "比較を選択" })
        .selectOption({ label: "固定改善課題" });
      await panel
        .getByRole("combobox", { name: "対象版" })
        .selectOption({ label });
      await panel
        .getByRole("textbox", { name: "評価根拠" })
        .fill("User inspected saved fixture output; explicit evaluation only");
      await panel
        .getByRole("checkbox", { name: "品質基準を満たすと確認した" })
        .check();
      await panel.getByRole("button", { name: "結果を登録" }).click();
      await expect(panel.locator("tbody")).toContainText("充足（明示評価）");
      await expect(panel.locator("tbody")).toContainText("模擬・参考値");
    };
    await evaluate("baseline（候補）");
    const adopt = async (reason: string, restore = false) => {
      await panel.getByRole("textbox", { name: "切替理由" }).fill(reason);
      await panel.getByRole("checkbox", { name: "操作を明示確認" }).check();
      await panel
        .getByRole("button", {
          name: restore ? "以前の採用版へ復帰" : "選択版を採用",
        })
        .click();
    };
    await adopt("Manual offline baseline acceptance");
    await expect(panel).toContainText("採用版 baseline");
    await panel.getByRole("textbox", { name: "候補名" }).fill("v2");
    await panel
      .getByRole("textbox", { name: "候補本文" })
      .fill("Verify task and answer pong concisely");
    await panel.getByRole("button", { name: "候補版を保存" }).click();
    await panel
      .getByRole("combobox", { name: "対象版" })
      .selectOption({ label: "v2（候補）" });
    await expect(panel.getByRole("textbox", { name: "評価根拠" })).toHaveValue(
      "",
    );
    await expect(
      panel.getByRole("checkbox", { name: "品質基準を満たすと確認した" }),
    ).not.toBeChecked();
    await evaluate("v2（候補）");
    await adopt("Manual v2 acceptance; no production superiority");
    await expect(panel).toContainText("採用版 v2");
    await gui.reload();
    await gui
      .getByRole("button", { name: "改善版の比較", exact: true })
      .click();
    await panel
      .getByRole("combobox", { name: "比較を選択" })
      .selectOption({ label: "固定改善課題" });
    await expect(panel.getByRole("combobox", { name: "対象版" })).toHaveValue(
      (await panel
        .getByRole("combobox", { name: "対象版" })
        .locator("option")
        .filter({ hasText: "v2（採用済み）" })
        .getAttribute("value")) ?? "",
    );
    await panel
      .getByRole("combobox", { name: "対象版" })
      .selectOption({ label: "baseline（候補）" });
    await adopt("Restore previously reviewed baseline", true);
    await expect(panel).toContainText("採用版 baseline");
    await expect(panel.locator("tbody tr")).toHaveCount(2);
    await panel.getByText("切替履歴", { exact: true }).click();
    await gui.screenshot({ path: info.outputPath("improvements.png") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
