import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

function repl(
  home: string,
  commands: string[],
  extra: string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/headless.ts", "--fake", ...extra],
      {
        cwd: process.cwd(),
        windowsHide: true,
        env: { ...process.env, XHARNESS_HOME: home },
      },
    );
    let output = "",
      pending = "",
      error = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Headless fixture timed out"));
    }, 15000);
    child.stdout.on("data", (bytes: Buffer) => {
      const chunk = bytes.toString();
      output += chunk;
      pending += chunk;
      if (pending.endsWith("❯ ") && commands.length) {
        pending = "";
        child.stdin.write(commands.shift()! + "\n");
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      error += bytes.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(error || "Headless fixture failed"));
    });
  });
}
it("persists and resumes the fake REPL with compact checkpoints and session mode", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-headless-phase4-"));
  const output = await repl(home, [
    "first",
    "second",
    "third",
    "/compact",
    "/mode plan",
    "/exit",
  ]);
  const id = /session ([\w-]+)/.exec(output)?.[1];
  expect(id).toBeTruthy();
  const history = await readFile(join(home, "sessions", `${id}.jsonl`), "utf8");
  expect(history.trim().split("\n")).toHaveLength(6);
  expect(output).toContain("History compacted");
  const checkpoint = JSON.parse(
    await readFile(join(home, "context", `${id}.json`), "utf8"),
  );
  expect(checkpoint.covered).toBe(2);
  expect(
    JSON.parse(await readFile(join(home, "sessions", "index.json"), "utf8"))[0]
      .permissionMode,
  ).toBe("plan");
  const resumed = await repl(home, ["fourth", "/exit"], ["--resume", id!]);
  expect(resumed).toContain(`session ${id}`);
  expect(
    await readFile(join(home, "sessions", `${id}.jsonl`), "utf8"),
  ).toContain(history);
}, 30000);
