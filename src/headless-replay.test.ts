import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it as vitestIt } from "vitest";

// Each case starts a TS-enabled Node process; startup competes with the suite.
const it = (name: string, test: () => Promise<void>) =>
  vitestIt(name, test, 30000);

const run = promisify(execFile);
it("exports an offline HTML report without session initialization or source writes", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-report-cli-"));
  await mkdir(join(home, "receipts"));
  const raw = await readFile(
    "test/fixtures/replay/receipts/haiku-read.jsonl",
    "utf8",
  );
  await writeFile(join(home, "receipts", "haiku-read.jsonl"), raw);
  const output = join(home, "report.html");
  const { stdout, stderr } = await replay(home, [
    "--report",
    "haiku-read",
    "--output",
    output,
  ]);
  expect(stdout).toBe("HTML report saved\n");
  expect(stderr).toBe("");
  expect(await readFile(output, "utf8")).toContain("XHarness 実行レポート");
  expect(
    await readFile(join(home, "receipts", "haiku-read.jsonl"), "utf8"),
  ).toBe(raw);
  expect(await readdir(home)).toEqual(["receipts", "report.html"]);
});
async function replay(home: string, args: string[]) {
  return run(
    process.execPath,
    ["--import", "tsx", "src/headless.ts", "--fake", ...args],
    {
      env: { ...process.env, XHARNESS_HOME: home },
      windowsHide: true,
      timeout: 15000,
    },
  );
}
it("replays real receipts without creating a session or changing saved records", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-replay-cli-"));
  await mkdir(join(home, "receipts"));
  const raw = await readFile(
    "test/fixtures/replay/receipts/haiku-read.jsonl",
    "utf8",
  );
  const file = join(home, "receipts", "haiku-read.jsonl");
  await writeFile(file, raw);
  const { stdout, stderr } = await replay(home, ["--replay", "haiku-read"]);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout).frames).toHaveLength(3);
  expect(await readFile(file, "utf8")).toBe(raw);
  expect(await readdir(home)).toEqual(["receipts"]);
});
it("compares a recorded Write under plan mode without executing it or making state files", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-replay-plan-"));
  await mkdir(join(home, "receipts"));
  const target = join(home, "target.txt");
  await writeFile(target, "unchanged");
  await writeFile(
    join(home, "receipts", "sample.jsonl"),
    JSON.stringify({
      id: "#1",
      sessionId: "sample",
      ts: 0,
      provider: "harness",
      kind: "tool",
      durationMs: 1,
      summary: "Write",
      tool: "Write",
      decision: "allow",
      input: { path: "target.txt", content: "changed" },
    }),
  );
  const { stdout } = await replay(home, [
    "--replay",
    "sample",
    "--replay-mode",
    "plan",
    "--cwd",
    home,
  ]);
  expect(JSON.parse(stdout).permissionComparisons[0]).toMatchObject({
    current: "deny",
    matches: false,
  });
  expect(await readFile(target, "utf8")).toBe("unchanged");
  expect((await readdir(home)).sort()).toEqual(["receipts", "target.txt"]);
});
it("rejects replay options that could accidentally enter the live REPL", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-replay-invalid-"));
  for (const args of [
    ["--replay-mode", "plan"],
    ["--replay", "x", "--model", "fake"],
    ["--replay", "../x"],
  ])
    await expect(replay(home, args)).rejects.toThrow();
  expect(await readdir(home)).toEqual([]);
});
