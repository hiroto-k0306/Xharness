import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { launchOfficialLogin, loginScript } from "./cli-login.js";

it.skipIf(process.platform !== "win32")(
  "distinguishes a missing PowerShell from a missing official CLI without starting login",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "xh-login-missing-"));
    expect(
      await launchOfficialLogin("claude", { ...process.env, PATH: dir }),
    ).toBe("shell_missing");
    const pwsh = execFileSync("where.exe", ["pwsh"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)[0]!;
    expect(
      await launchOfficialLogin("claude", {
        ...process.env,
        PATH: dirname(pwsh),
      }),
    ).toBe("cli_missing");
  },
);

it.skipIf(process.platform !== "win32")(
  "selects one executable when PowerShell discovers multiple matches",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "xh-login-multiple-"));
    const output = join(dir, "args.txt");
    await writeFile(
      join(dir, "claude.cmd"),
      `@echo off\r\necho %*>"${output}"\r\nexit /b 0\r\n`,
    );
    // Get-Command can yield multiple paths (MSIX executable plus app execution alias).
    // Force that discovery shape while keeping the actual host and CLI isolated.
    const script = `$realPwsh = (Get-Command pwsh -CommandType Application | Select-Object -First 1).Source; function Get-Command { param($Name, $CommandType); if ($Name -eq 'pwsh') { [pscustomobject]@{Source=$realPwsh}; [pscustomobject]@{Source=$realPwsh} } else { Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters } }; ${loginScript("claude")}`;
    const env = {
      ...process.env,
      PATH: `${dir};${process.env.PATH}`,
      CODEX_HOME: dir,
      CLAUDE_CONFIG_DIR: dir,
    };
    execFileSync(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { env, windowsHide: true, stdio: "ignore" },
    );
    expect((await readFile(output, "utf8")).trim()).toBe(
      "auth login --claudeai",
    );
  },
  15000,
);

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
