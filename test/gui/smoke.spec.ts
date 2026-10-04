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
  expect(await electronApp.evaluate(({ app }) => app.isPackaged)).toBe(false);
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

test("scratch ping pong and panel switching", async ({
  gui,
  electronApp,
}, testInfo) => {
  await gui.getByRole("button", { name: /new session/ }).click();
  const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
  await expect(prompt).toBeEnabled();
  await prompt.fill("ping");
  await prompt.press("Enter");
  await expect(gui.getByText("pong", { exact: true })).toBeVisible();
  await expect(prompt).toBeEnabled();
  await expect(prompt).toHaveValue("");
  await gui.screenshot({ path: testInfo.outputPath("pong.png") });

  // 切替タブは 1099px 以下で表示される。専用のテストウィンドウだけをリサイズする。
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]!.setSize(1000, 760);
  });
  const loop = gui.getByRole("complementary", {
    name: "agent loop",
    exact: true,
  });
  const flow = gui.getByRole("tab", { name: "LoopFlow", exact: true });
  const transcript = gui.getByRole("tab", { name: "Transcript", exact: true });
  await flow.click();
  await expect(flow).toHaveAttribute("aria-selected", "true");
  await expect(transcript).toHaveAttribute("aria-selected", "false");
  await expect(loop).toBeVisible();
  await expect(gui.getByText("pong", { exact: true })).toBeHidden();
  await gui.screenshot({ path: testInfo.outputPath("flow.png") });
  await transcript.click();
  await expect(transcript).toHaveAttribute("aria-selected", "true");
  await expect(loop).toBeHidden();
  await expect(gui.getByText("pong", { exact: true })).toBeVisible();
});
