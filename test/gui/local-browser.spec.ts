import { test, expect } from "./electron.fixture.js";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("real isolated Electron local fixture observes, confirms one DOM click, receipts and stops without model calls", async ({
  gui,
  electronApp,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "xh-local-browser-gui-"));
  try {
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
    const made = await gui.evaluate(
      (workspaceId) =>
        window.harness.command({ type: "new_session", workspaceId }),
      picked.workspaceId,
    );
    if (!made.ok || !made.sessionId) throw new Error("session");
    const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
    // A dummy cookie in the test app's profile proves it is not copied/shared.
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      await BrowserWindow.getAllWindows()[0]!.webContents.session.cookies.set({
        url: "http://localhost/",
        name: "fixture_cookie",
        value: "dummy-not-a-secret",
      });
    });
    await gui
      .getByRole("button", { name: "ローカル操作の土台", exact: true })
      .click();
    const panel = gui.getByRole("dialog", { name: "ローカル操作の土台" });
    await panel
      .getByRole("button", { name: "隔離fixtureを観測", exact: true })
      .click();
    await expect(panel.getByRole("status")).toContainText("観測済み");
    await expect(panel.getByRole("status")).toContainText("実Electron");
    await expect(
      panel.getByRole("img", { name: "未信頼のローカルfixture観測" }),
    ).toBeVisible();
    await expect(panel).toContainText("count: 0");
    const isolation = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const browser = windows.find((w) =>
        w.webContents.getURL().startsWith("data:text/html"),
      )!;
      const main = windows.find((w) => w !== browser)!;
      return {
        shared: browser.webContents.session === main.webContents.session,
        persistent: browser.webContents.session.isPersistent(),
        cookies: await browser.webContents.session.cookies.get({}),
        size: browser.getContentSize(),
        zoom: browser.webContents.getZoomFactor(),
      };
    });
    expect(isolation).toEqual({
      shared: false,
      persistent: false,
      cookies: [],
      size: [580, 360],
      zoom: 1,
    });
    await gui.screenshot({
      path: info.outputPath("local-browser-observation.png"),
      fullPage: false,
    });
    await panel
      .getByRole("button", { name: "この観測の単一操作を確認", exact: true })
      .click();
    await expect(panel.getByRole("status")).toContainText("許可待ち");
    await expect(
      panel.getByRole("button", { name: "単一操作を明示実行", exact: true }),
    ).toBeDisabled();
    await panel.getByRole("checkbox").check();
    await panel
      .getByRole("button", { name: "単一操作を明示実行", exact: true })
      .click();
    await expect(
      panel.getByText("操作・保存確定", { exact: true }),
    ).toBeVisible();
    await expect(panel).toContainText("結果count: 1");
    const journal = JSON.parse(
      await readFile(
        join(home, "local-browser", `${made.sessionId}.json`),
        "utf8",
      ),
    );
    expect(journal.operations).toHaveLength(1);
    expect(journal.operations[0]).toMatchObject({
      status: "succeeded",
      mode: "electron_local",
      countAfter: 1,
    });
    const receipts = await readFile(
      join(home, "receipts", `${made.sessionId}.jsonl`),
      "utf8",
    );
    expect(receipts).toContain("LocalBrowserClick");
    expect(receipts).not.toContain("model_call");
    expect(receipts).not.toContain("data:image/png");
    await expect(
      readFile(join(home, "sessions", `${made.sessionId}.jsonl`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      await electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
    await gui.reload();
    await gui
      .getByRole("button", { name: "ローカル操作の土台", exact: true })
      .click();
    await expect(
      panel.getByText("操作・保存確定", { exact: true }),
    ).toBeVisible();
    await gui.screenshot({
      path: info.outputPath("local-browser-stopped.png"),
      fullPage: false,
    });
    // Fault fixture: model a crash after intent but before final journal save.
    journal.operations[0].status = "pending";
    delete journal.operations[0].finishedAt;
    delete journal.operations[0].countAfter;
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        join(home, "local-browser", `${made.sessionId}.json`),
        JSON.stringify(journal),
      ),
    );
    await gui.reload();
    await gui
      .getByRole("button", { name: "ローカル操作の土台", exact: true })
      .click();
    await expect(panel.getByRole("status")).toContainText(
      "結果不明・再実行禁止",
    );
    await expect(
      panel.getByRole("button", { name: "隔離fixtureを観測", exact: true }),
    ).toBeDisabled();
    const retry = await gui.evaluate(
      (data) =>
        window.harness.command({
          type: "local_browser",
          sessionId: data.id,
          request: {
            action: "confirm",
            confirmationId: data.operationId,
            confirmed: true,
          },
        }),
      { id: made.sessionId, operationId: journal.operations[0].id },
    );
    expect(retry.ok).toBe(false);
    expect(
      await electronApp.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
    ).toBe(1);
    await gui.screenshot({
      path: info.outputPath("local-browser-unknown.png"),
      fullPage: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local DOM mutation and reload invalidate confirmation instead of executing stale coordinates", async ({
  gui,
  electronApp,
}) => {
  const root = await mkdtemp(join(tmpdir(), "xh-local-browser-stale-"));
  try {
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
    await gui
      .getByRole("button", { name: "ローカル操作の土台", exact: true })
      .click();
    const panel = gui.getByRole("dialog", { name: "ローカル操作の土台" });
    for (const mutation of ["dom", "reload"]) {
      await panel
        .getByRole("button", { name: "隔離fixtureを観測", exact: true })
        .click();
      await expect(panel.getByRole("status")).toContainText("観測済み");
      await panel
        .getByRole("button", { name: "この観測の単一操作を確認", exact: true })
        .click();
      await expect(panel.getByRole("status")).toContainText("許可待ち");
      await electronApp.evaluate(async ({ BrowserWindow }, kind) => {
        const wc = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith("data:text/html"),
        )!.webContents;
        if (kind === "dom")
          await wc.executeJavaScript(
            "document.getElementById('count').textContent='99'",
          );
        else
          await new Promise<void>((resolve) => {
            wc.once("did-finish-load", () => resolve());
            wc.reload();
          });
      }, mutation);
      await panel.getByRole("checkbox").check();
      await panel
        .getByRole("button", { name: "単一操作を明示実行", exact: true })
        .click();
      await expect(panel.getByRole("alert")).toContainText("確認後");
      expect(
        await electronApp.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      ).toBe(1);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
