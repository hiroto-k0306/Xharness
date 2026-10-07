import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
test("SIWC account lifecycle uses mock OAuth and real Windows protected isolated storage", async () => {
  test.skip(process.platform !== "win32");
  const home = await mkdtemp(join(tmpdir(), "xh-siwc-gui-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) =>
        v !== undefined &&
        ![
          "ELECTRON_RUN_AS_NODE",
          "ELECTRON_RENDERER_URL",
          "NODE_OPTIONS",
        ].includes(k),
    ),
  ) as Record<string, string>;
  const launch = () =>
    electron.launch({
      cwd: resolve("."),
      args: [resolve("."), "--fake", "--connection-test", "--siwc-fixture"],
      env: { ...env, XHARNESS_HOME: home },
      timeout: 15000,
    });
  // The first launch is an empty profile. Later launch restores ciphertext through DPAPI.
  let application = await launch();
  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: /new session/ }).click();
    const open = page.getByRole("button", { name: /^接続方式:/ });
    await open.click();
    await page
      .getByRole("combobox", { name: "接続方式" })
      .selectOption("openai-siwc");
    await page
      .getByRole("button", { name: "Continue with ChatGPT", exact: true })
      .click();
    await expect(
      page.getByText("ChatGPT account 1（選択中）", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Got it" }).click();
    await page.getByRole("button", { name: "利用可能モデルを確認" }).click();
    await page.getByRole("button", { name: /gpt-5\.4 を使用/ }).click();
    await page.getByRole("button", { name: "接続を適用" }).click();
    const prompt = page.getByRole("textbox", { name: "prompt", exact: true });
    await prompt.fill("Synthetic fixture only");
    await prompt.press("Enter");
    await expect(page.getByText("SIWC-OK", { exact: true })).toBeVisible();
    const files = await readdir(join(home, "siwc-protected"));
    for (const file of files.filter((f) => f.endsWith(".bin"))) {
      const bytes = await readFile(join(home, "siwc-protected", file));
      expect(bytes.toString()).not.toMatch(
        /fixture-(access|refresh|subject|id)|oaiapp_fixture/,
      );
    }
    const rendered = await page.locator("body").innerText();
    expect(rendered).not.toMatch(
      /fixture-(access|refresh|subject|id)|oaiapp_fixture/,
    );
    // Restore via a non-empty home without the empty-only connection-test profile.
    await application.close();
    application = await electron.launch({
      cwd: resolve("."),
      args: [resolve("."), "--fake", "--siwc-fixture"],
      env: { ...env, XHARNESS_HOME: home },
      timeout: 15000,
    });
    const restored = await application.firstWindow();
    await restored.getByRole("button", { name: /new session/ }).click();
    await restored.getByRole("button", { name: /^接続方式:/ }).click();
    await restored
      .getByRole("combobox", { name: "接続方式" })
      .selectOption("openai-siwc");
    await restored.getByRole("button", { name: "保存済み接続を確認" }).click();
    await expect(
      restored.getByText("ChatGPT account 1（選択中）", { exact: false }),
    ).toBeVisible();
    await expect(restored.getByRole("button", { name: "Got it" })).toHaveCount(
      0,
    );
    await restored
      .getByRole("button", { name: "サインアウト", exact: true })
      .click();
    await expect(
      restored.getByText(/ChatGPT account 1.*サインアウト済み/),
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
