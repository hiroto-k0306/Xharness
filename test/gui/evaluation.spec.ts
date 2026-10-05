import { test, expect } from "./electron.fixture.js";
import { readFile } from "node:fs/promises";

test("exports and displays evaluation from an isolated fake UI task", async ({
  gui,
  electronApp,
}, testInfo) => {
  const created = await gui.evaluate(() =>
    window.harness.command({ type: "new_session", workspaceId: null }),
  );
  if (!created.ok || !created.sessionId)
    throw new Error("Fake session missing");
  const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
  await prompt.fill("ping");
  await prompt.press("Enter");
  await expect(gui.getByText("pong", { exact: true })).toBeVisible();
  await expect(prompt).toBeEnabled();
  const output = testInfo.outputPath("evaluation.html");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, output);
  const exported = await gui.evaluate(
    (sessionId) => window.harness.command({ type: "export_report", sessionId }),
    created.sessionId,
  );
  expect(exported.ok).toBe(true);
  const html = await readFile(output, "utf8");
  await gui.setContent(html);
  await expect(
    gui.getByRole("heading", { name: "品質・使用量の評価" }),
  ).toBeVisible();
  await expect(gui.locator("#evaluation")).toContainText("completed");
  await expect(gui.locator("#evaluation")).toContainText("品質結果:");
  await expect(gui.locator("#evaluation")).toContainText("所要時間:");
  await expect(
    gui.locator("#evaluation th").filter({ hasText: /^In$/ }),
  ).toBeVisible();
  await expect(
    gui.locator("#evaluation th").filter({ hasText: /^Out$/ }),
  ).toBeVisible();
  await expect(gui.locator("#evaluation")).not.toContainText("API換算");
  await expect(gui.locator("#evaluation")).toContainText("模擬 1");
  await expect(gui.locator("#evaluation")).toContainText("完全なusage: 1/1");
  await expect(gui.locator("#evaluation")).toContainText("実fetch送信記録 0");
  expect(
    await gui.locator("#evaluation a").first().getAttribute("href"),
  ).toMatch(/^#trace-/);
  expect(
    await gui.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await gui.screenshot({
    path: testInfo.outputPath("evaluation.png"),
    fullPage: false,
  });
});
