import { test, expect } from "./electron.fixture.js";
import { _electron as electron } from "@playwright/test";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("packaged restart preserves records and a killed process never replays pending work", async ({
  gui,
  electronApp,
}, info) => {
  test.skip(!process.env.XHARNESS_TEST_EXECUTABLE, "配布exe専用の確認");
  const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
  const project = info.outputPath("isolated-project");
  await mkdir(project, { recursive: true });
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
  }, project);
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
  const id = made.sessionId;
  const prompt = gui.getByRole("textbox", { name: "prompt", exact: true });
  await prompt.fill("ping");
  await prompt.press("Enter");
  await expect(
    gui.getByText("模擬回答：計画・実装は開始していません。", { exact: true }),
  ).toBeVisible();
  await expect(prompt).toBeEnabled();
  const historyPath = join(home, "sessions", `${id}.jsonl`);
  const history = await readFile(historyPath, "utf8");
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
  const launch = () =>
    electron.launch({
      executablePath: process.env.XHARNESS_TEST_EXECUTABLE,
      args: ["--fake"],
      env: { ...env, XHARNESS_HOME: home },
      timeout: 20_000,
    });
  const open = async (app: Awaited<ReturnType<typeof launch>>) => {
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(
      join(home, "electron-user-data"),
    );
    const page = await app.firstWindow();
    await expect(page.getByText("FAKE", { exact: true })).toBeVisible();
    expect(
      await page.evaluate(
        (sessionId) =>
          window.harness.command({ type: "open_session", sessionId }),
        id,
      ),
    ).toMatchObject({ ok: true });
    return page;
  };
  await electronApp.close();
  const restarted = await launch();
  const restartedProcess = restarted.process();
  try {
    const page = await open(restarted);
    await expect(
      page.getByText("模擬回答：計画・実装は開始していません。", {
        exact: true,
      }),
    ).toBeVisible();
    expect(await readFile(historyPath, "utf8")).toBe(history);
    await page
      .getByRole("button", { name: "ローカル操作の土台", exact: true })
      .click();
    const panel = page.getByRole("dialog", { name: "ローカル操作の土台" });
    await panel
      .getByRole("button", { name: "隔離fixtureを観測", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "この観測の単一操作を確認", exact: true })
      .click();
    await panel.getByRole("checkbox").check();
    await panel
      .getByRole("button", { name: "単一操作を明示実行", exact: true })
      .click();
    await expect(
      panel.getByText("操作・保存確定", { exact: true }),
    ).toBeVisible();
    // Isolated crash fixture: durable intent without a known final outcome.
    const journalPath = join(home, "local-browser", `${id}.json`);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    journal.operations[0].status = "pending";
    delete journal.operations[0].finishedAt;
    delete journal.operations[0].countAfter;
    await writeFile(journalPath, JSON.stringify(journal));
    await appendFile(
      join(home, "sessions", `${id}.evaluation.jsonl`),
      JSON.stringify({
        evaluationTask: { id: "release-crash", active: true, settled: false },
      }) + "\n",
    );
    const mainPid = await restarted.evaluate(() => process.pid);
    const exited = new Promise<void>((resolve) =>
      restartedProcess.once("exit", () => resolve()),
    );
    // Windows packaged Electron may have a launcher PID distinct from its main.
    // Kill only this verified isolated main and its descendants; never by name.
    await promisify(execFile)(
      "taskkill.exe",
      ["/PID", String(mainPid), "/T", "/F"],
      { windowsHide: true },
    );
    await exited;
    const recovered = await launch();
    try {
      const recoveryPage = await open(recovered);
      expect(await readFile(historyPath, "utf8")).toBe(history);
      const sent = await recoveryPage.evaluate(
        (sessionId) =>
          window.harness.command({
            type: "send",
            sessionId,
            text: "must not replay",
          }),
        id,
      );
      expect(sent).toMatchObject({ ok: false });
      if (!sent.ok) expect(sent.error).toContain("前回の保存が未確定");
      await recoveryPage
        .getByRole("button", { name: "ローカル操作の土台", exact: true })
        .click();
      const recoveryPanel = recoveryPage.getByRole("dialog", {
        name: "ローカル操作の土台",
      });
      await expect(recoveryPanel.getByRole("status")).toContainText(
        "結果不明・再実行禁止",
      );
      await expect(
        recoveryPanel.getByRole("button", {
          name: "隔離fixtureを観測",
          exact: true,
        }),
      ).toBeDisabled();
      expect(
        await recovered.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
        ),
      ).toBe(1);
      expect(await readFile(journalPath, "utf8")).toBe(JSON.stringify(journal));
      expect(await readFile(historyPath, "utf8")).toBe(history);
      await recoveryPage.screenshot({
        path: info.outputPath("packaged-crash-recovery.png"),
      });
    } finally {
      await recovered.close();
    }
  } finally {
    if (restartedProcess.exitCode === null) await restarted.close();
  }
});
