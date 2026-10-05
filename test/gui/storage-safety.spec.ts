import { test, expect } from "./electron.fixture.js";
import { _electron as electron } from "@playwright/test";
import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("desktop fences same-home headless while another fake home can start", async ({
  gui,
  electronApp,
}) => {
  const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
  const rejected = await new Promise<{ code: number | null; text: string }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "src/headless.ts", "--fake"],
        {
          cwd: process.cwd(),
          env: { ...process.env, XHARNESS_HOME: home },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      let text = "";
      child.stdout.on("data", (data) => (text += String(data)));
      child.stderr.on("data", (data) => (text += String(data)));
      child.on("error", reject);
      child.on("close", (code) => done({ code, text }));
      child.stdin.end("/exit\n");
    },
  );
  expect(rejected.code).toBe(1);
  expect(rejected.text).toContain("同じ保存先");
  await expect(
    gui.getByRole("textbox", { name: "prompt", exact: true }),
  ).toBeEnabled();
  const secondHome = await mkdtemp(join(tmpdir(), "xh-writer-gui-other-"));
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
  let second: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    second = await electron.launch({
      cwd: process.cwd(),
      args: [resolve("."), "--fake"],
      env: { ...env, XHARNESS_HOME: secondHome },
    });
    const page = await second.firstWindow();
    await expect(page.getByText("FAKE", { exact: true })).toBeVisible();
    await expect(gui.getByText("FAKE", { exact: true })).toBeVisible();
  } finally {
    await second?.close();
    const target = resolve(secondHome);
    if (!target.startsWith(resolve(tmpdir()) + "\\"))
      throw new Error("Invalid temporary cleanup path");
    await rm(target, { recursive: true, force: true, maxRetries: 5 });
  }
});
test("shows uncommitted records and refuses execution while preserving report export", async ({
  gui,
  electronApp,
}, testInfo) => {
  const created = await gui.evaluate(() =>
    window.harness.command({ type: "new_session", workspaceId: null }),
  );
  if (!created.ok || !created.sessionId) throw new Error("session missing");
  const home = await electronApp.evaluate(() => process.env.XHARNESS_HOME!);
  await appendFile(
    join(home, "sessions", created.sessionId + ".evaluation.jsonl"),
    JSON.stringify({
      evaluationTask: { id: "interrupted", active: true, settled: false },
    }) + "\n",
  );
  const result = await gui.evaluate(
    (sessionId) =>
      window.harness.command({ type: "send", sessionId, text: "ping" }),
    created.sessionId,
  );
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("前回の保存が未確定");
  const output = testInfo.outputPath("recovery.html");
  await electronApp.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, output);
  expect(
    (
      await gui.evaluate(
        (sessionId) =>
          window.harness.command({ type: "export_report", sessionId }),
        created.sessionId,
      )
    ).ok,
  ).toBe(true);
  await gui.setContent(await readFile(output, "utf8"));
  await expect(gui.getByRole("alert")).toContainText("保存未確定");
  await expect(gui.getByRole("alert")).toContainText(
    "欠測をゼロや成功に補いません",
  );
  await gui.screenshot({ path: testInfo.outputPath("recovery.png") });
});
