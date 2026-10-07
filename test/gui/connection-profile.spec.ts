import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("isolated connection profile starts without checking SDK or dispatching legacy", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-profile-gui-"));
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
  const app = await electron.launch({
    cwd: resolve("."),
    args: [resolve("."), "--connection-test"],
    env: { ...env, XHARNESS_HOME: home },
  });
  try {
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(
      join(home, "electron-user-data"),
    );
    const page = await app.firstWindow();
    const created = await page.evaluate(() =>
      window.harness.command({ type: "new_session", workspaceId: null }),
    );
    if (!created.ok || !created.sessionId)
      throw new Error("No fixture session");
    const sent = await page.evaluate(
      (id) =>
        window.harness.command({
          type: "send",
          sessionId: id!,
          text: "Never dispatch legacy",
        }),
      created.sessionId,
    );
    expect(sent.ok).toBe(false);
    if (sent.ok) throw new Error("Legacy fixture dispatch must be refused");
    expect(sent.error).toContain("Fixture profile");
    await page.getByRole("button", { name: /^接続方式:/ }).click();
    await page
      .getByRole("combobox", { name: "接続方式" })
      .selectOption("claude-mcp");
    await expect(page.getByRole("status")).toContainText("認可必要");
  } finally {
    await app.close();
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
