import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { type ProviderName } from "../../shared/ipc.js";
import { resolveCli } from "../tools/environment.js";
import { dirname, delimiter } from "node:path";

export type LoginResult =
  boolean | "shell_missing" | "cli_missing" | "launch_failed";

/** Fixed commands only; authentication runs in its own interactive console. */
export function loginScript(provider: ProviderName) {
  const command =
    provider === "claude"
      ? "& (Get-Command claude -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source auth login --claudeai"
      : "& (Get-Command codex -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source login";
  const inner = `$ErrorActionPreference = 'Stop'; try { ${command}; exit $LASTEXITCODE } catch { Write-Host '公式CLIが見つかりません。インストールを確認してください。'; Read-Host 'Enterで閉じる'; exit 1 }`;
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  return `$ErrorActionPreference = 'Stop'; if (!(Get-Command ${provider} -CommandType Application -ErrorAction SilentlyContinue)) { exit 20 }; try { $p = Start-Process -FilePath (Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source -WorkingDirectory $HOME -ArgumentList @('-NoLogo','-NoProfile','-EncodedCommand','${encoded}') -PassThru -Wait; if ($p.ExitCode -eq 0) { exit 0 }; exit 1 } catch { exit 21 }`;
}

export async function launchOfficialLogin(
  provider: ProviderName,
  env = process.env,
): Promise<LoginResult> {
  if (process.platform !== "win32") return Promise.resolve(false);
  const shell = await resolveCli("pwsh", env);
  if (!shell) return "shell_missing";
  return new Promise((resolve) => {
    const child = spawn(
      shell,
      [
        "-NoLogo",
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(loginScript(provider), "utf16le").toString("base64"),
      ],
      {
        cwd: homedir(),
        env: { ...env, PATH: dirname(shell) + delimiter + (env.PATH ?? "") },
        windowsHide: true,
        stdio: "ignore",
      },
    );
    child.once("error", (error: NodeJS.ErrnoException) =>
      resolve(error.code === "ENOENT" ? "shell_missing" : "launch_failed"),
    );
    child.once("close", (code) =>
      resolve(
        code === 20
          ? "cli_missing"
          : code === 21
            ? "launch_failed"
            : code === 0,
      ),
    );
    child.unref();
  });
}
