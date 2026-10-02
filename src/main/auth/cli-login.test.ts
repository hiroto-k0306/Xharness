import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { launchOfficialLogin } from "./cli-login.js";

it.skipIf(process.platform !== "win32")(
  "launches fixed login commands through PowerShell without using real credentials or CLIs",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "xh-login-cli-"));
    const pwsh = execFileSync("where.exe", ["pwsh"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)[0]!;
    const output = join(dir, "args.txt");
    const env = {
      ...process.env,
      PATH: [
        dir,
        dirname(pwsh),
        join(process.env.SystemRoot!, "System32"),
      ].join(";"),
      CODEX_HOME: dir,
      CLAUDE_CONFIG_DIR: dir,
    };
    for (const provider of ["claude", "codex"] as const) {
      await writeFile(
        join(dir, `${provider}.cmd`),
        `@echo off\r\necho %*>"${output}"\r\nexit /b 0\r\n`,
      );
      expect(await launchOfficialLogin(provider, env)).toBe(true);
      expect((await readFile(output, "utf8")).trim()).toBe(
        provider === "claude" ? "auth login --claudeai" : "login",
      );
    }
  },
  15000,
);
