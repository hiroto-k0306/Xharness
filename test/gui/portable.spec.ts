import { test, expect, chromium } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  rm,
  access,
  readFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";

async function port() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

test("portable executable keeps two fake homes and extraction resources isolated", async ({}, info) => {
  test.skip(!process.env.XHARNESS_TEST_PORTABLE, "ポータブル配布exe専用の確認");
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "xh-portable-release-"));
  const extraction = join(root, "extraction");
  await mkdir(extraction);
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
  const children: ChildProcess[] = [];
  const browsers: Awaited<ReturnType<typeof chromium.connectOverCDP>>[] = [];
  const launch = async (home: string) => {
    const number = await port();
    const child = spawn(
      process.env.XHARNESS_TEST_PORTABLE!,
      [
        "--fake",
        `--remote-debugging-port=${number}`,
        "--remote-debugging-address=127.0.0.1",
      ],
      {
        env: { ...env, XHARNESS_HOME: home, TEMP: extraction, TMP: extraction },
        windowsHide: true,
        stdio: "ignore",
      },
    );
    children.push(child);
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null)
            throw new Error("Portable launcher exited");
          try {
            return (await fetch(`http://127.0.0.1:${number}/json/version`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${number}`);
    browsers.push(browser);
    const page = browser.contexts()[0]!.pages()[0]!;
    await expect(page.getByText("FAKE", { exact: true })).toBeVisible();
    await access(join(home, "electron-user-data"));
    return { child, page };
  };
  const asars = async () =>
    (await readdir(extraction, { recursive: true }))
      .filter((name) => name.endsWith(join("app", "resources", "app.asar")))
      .map((name) => join(extraction, name));
  const close = async (instance: Awaited<ReturnType<typeof launch>>) => {
    const exited = new Promise<void>((done) =>
      instance.child.once("exit", () => done()),
    );
    await instance.page.evaluate(() => window.close()).catch(() => undefined);
    await exited;
  };
  try {
    const aHome = join(root, "home-a"),
      bHome = join(root, "home-b");
    const a = await launch(aHome);
    const first = await asars();
    expect(first).toHaveLength(1);
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex");
    expect(digest(await readFile(first[0]!))).toBe(
      digest(await readFile(resolve("dist/win-unpacked/resources/app.asar"))),
    );
    const b = await launch(bHome);
    const second = await asars();
    expect(second).toHaveLength(2);
    expect(new Set(second).size).toBe(2);
    await close(b);
    await access(first[0]!);
    const made = await a.page.evaluate(() =>
      window.harness.command({ type: "new_session", workspaceId: null }),
    );
    if (!made.ok || !made.sessionId) throw new Error("session");
    const prompt = a.page.getByRole("textbox", { name: "prompt", exact: true });
    await prompt.fill("ping");
    await prompt.press("Enter");
    await expect(a.page.getByText("pong", { exact: true })).toBeVisible();
    await expect(prompt).toBeEnabled();
    expect(
      await readFile(
        join(aHome, "sessions", `${made.sessionId}.jsonl`),
        "utf8",
      ),
    ).toContain("pong");
    await a.page.screenshot({
      path: info.outputPath("portable-after-second-exit.png"),
    });
    await close(a);
  } finally {
    for (const browser of browsers.reverse())
      await browser.close().catch(() => undefined);
    for (const child of children.reverse())
      if (child.exitCode === null && child.pid)
        await promisify(execFile)(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true },
        ).catch(() => undefined);
    if (!resolve(root).startsWith(resolve(tmpdir()) + "\\"))
      throw new Error("Invalid cleanup path");
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
