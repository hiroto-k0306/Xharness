import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export const test = base.extend<{
  electronApp: ElectronApplication;
  gui: Page;
}>({
  electronApp: async ({}, use) => {
    const home = await mkdtemp(join(tmpdir(), "xharness-gui-"));
    let application: ElectronApplication | undefined;
    try {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key, value]) =>
            value !== undefined &&
            ![
              "ELECTRON_RUN_AS_NODE",
              "ELECTRON_RENDERER_URL",
              "NODE_OPTIONS",
            ].includes(key),
        ),
      ) as Record<string, string>;
      const executablePath = process.env.XHARNESS_TEST_EXECUTABLE;
      application = await electron.launch({
        cwd: root,
        ...(executablePath ? { executablePath } : {}),
        args: executablePath ? ["--fake"] : [root, "--fake"],
        env: { ...env, XHARNESS_HOME: home },
        timeout: 15_000,
      });
      // メインプロセスで確認する。既存プロファイルへの接続なら操作せず失敗させる。
      expect(
        await application.evaluate(({ app }) => ({
          userData: app.getPath("userData"),
          sessionData: app.getPath("sessionData"),
        })),
      ).toEqual({
        userData: join(home, "electron-user-data"),
        sessionData: join(home, "electron-user-data"),
      });
      if (executablePath) {
        expect(await application.evaluate(({ app }) => app.isPackaged)).toBe(
          true,
        );
        expect(
          await application.evaluate(({ app }) => app.getPath("exe")),
        ).toBe(resolve(executablePath));
      }
      await use(application);
    } finally {
      try {
        if (application && application.process().exitCode === null)
          await application.close();
      } finally {
        await rm(home, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  },
  gui: async ({ electronApp }, use, testInfo) => {
    const page = await electronApp.firstWindow();
    // ブラウザの確認を受諾しない。OS ネイティブダイアログも操作しない。
    page.on("dialog", (dialog) => void dialog.dismiss());
    try {
      await expect(page.getByText("FAKE", { exact: true })).toBeVisible();
      await use(page);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
        const path = testInfo.outputPath("failure.png");
        const image = await page
          .screenshot({ path, timeout: 5_000 })
          .catch(() => undefined);
        if (image)
          await testInfo.attach("failure", {
            path,
            contentType: "image/png",
          });
      }
    }
  },
});

export { expect };
