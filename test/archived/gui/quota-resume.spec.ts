import { test, expect } from "../../gui/electron.fixture.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

test("fake quota UI defaults off and exposes opt-in and cancel", async ({
  gui,
  electronApp,
}, testInfo) => {
  const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
  await writeFile(
    join(home, "config.yaml"),
    "workflow: {mode: off}\nfallback: {claude: null, codex: null}\n",
  );
  const created = await gui.evaluate(() =>
    window.harness.command({ type: "new_session", workspaceId: null }),
  );
  expect(created.ok).toBe(true);
  const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
  await prompt.fill("quota-demo");
  await prompt.press("Enter");
  const panel = gui.getByRole("status", { name: "利用枠の再開予定" });
  await expect(panel).toContainText("paused");
  await expect(panel).toContainText("既定OFF");
  await expect(panel).toContainText("5h");
  await expect(panel).toContainText("次の確認:");
  await panel
    .getByRole("button", { name: "条件を再確認して自動再開を有効化" })
    .click();
  await expect(panel).toContainText("waiting");
  await panel.getByRole("button", { name: "再開を取り消す" }).click();
  await expect(panel).toContainText("cancelled");
  await expect(panel.getByRole("button")).toHaveCount(0);
  await gui.screenshot({ path: testInfo.outputPath("quota-cancelled.png") });
});
