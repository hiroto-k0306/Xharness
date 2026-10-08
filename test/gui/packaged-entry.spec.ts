import { test, expect, _electron as electron } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("production official entry refuses an unavailable fixed CLI and incomplete plan without fallback", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-packaged-official-"));
  await mkdir(join(home, "official-workflows"));
  await writeFile(
    join(home, "official-workflows/connection.json"),
    JSON.stringify({
      codexMode: "fixed",
      codexPath: join(home, "missing/codex.exe"),
    }),
  );
  const env: NodeJS.ProcessEnv = { ...process.env, XHARNESS_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  delete env.NODE_OPTIONS;
  const app = await electron.launch({
    executablePath: process.env.XHARNESS_TEST_EXECUTABLE,
    args: ["--official-only"],
    env: env as Record<string, string>,
  });
  try {
    expect(
      await app.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        profile: app.getPath("userData"),
      })),
    ).toEqual({ packaged: true, profile: join(home, "electron-user-data") });
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: /^接続方式:/ })).toHaveCount(
      0,
    );
    await page
      .getByRole("button", { name: "公式workflow", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "合成課題の計画を作成" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "質問だけ送信" }),
    ).toBeDisabled();
    await page
      .getByRole("textbox", { name: "公式Codex実行パス" })
      .fill("relative.exe");
    await page.getByRole("button", { name: "公式接続設定を保存" }).click();
    await expect(page.getByRole("alert")).toContainText("絶対パス");
    const state = await page.evaluate(() =>
      window.harness.officialWorkflow!({
        action: "create",
        provider: "claude",
      }),
    );
    expect(state.records).toEqual([]);
    expect(state.available).toBe(false);
    expect(state.connection?.codexMode).toBe("fixed");
    expect(state.activeId).toBeUndefined();
    expect(state.error).toContain("計画モデルが選択されていません");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
