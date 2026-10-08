import { test, expect } from "./electron.fixture.js";

test("startup is fake and isolated", async ({ gui, electronApp }, testInfo) => {
  await expect(
    gui.getByRole("complementary", { name: "sessions" }),
  ).toBeVisible();
  await expect(
    gui.getByText("# セッションはまだありません", { exact: true }),
  ).toBeVisible();
  await expect(
    gui.getByRole("textbox", { name: "prompt", exact: true }),
  ).toBeEnabled();
  expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(
    !!process.env.XHARNESS_TEST_EXECUTABLE,
  );
  // 公開された preload API は使えるが、画面から Node は使えない。
  expect(
    await gui.evaluate(() => ({
      command: typeof window.harness.command,
      nodeProcess: typeof process,
      nodeRequire: typeof require,
    })),
  ).toEqual({
    command: "function",
    nodeProcess: "undefined",
    nodeRequire: "undefined",
  });
  await gui.screenshot({ path: testInfo.outputPath("startup.png") });
});
