import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { type ProviderName } from "../../shared/ipc.js";

/** Fixed commands only; authentication runs in its own interactive console. */
export function loginScript(provider: ProviderName) {
  const command =
    provider === "claude"
      ? "& (Get-Command claude -CommandType Application -ErrorAction Stop).Source auth login --claudeai"
      : "& (Get-Command codex -CommandType Application -ErrorAction Stop).Source login";
  const inner = `$ErrorActionPreference = 'Stop'; try { ${command}; exit $LASTEXITCODE } catch { Write-Host '公式CLIが見つかりません。インストールを確認してください。'; Read-Host 'Enterで閉じる'; exit 1 }`;
  const encoded = Buffer.from(inner, "utf16le").toString("base64");
  return `$ErrorActionPreference = 'Stop'; try { $p = Start-Process -FilePath (Get-Command pwsh -CommandType Application -ErrorAction Stop).Source -WorkingDirectory $HOME -ArgumentList @('-NoLogo','-NoProfile','-EncodedCommand','${encoded}') -PassThru -Wait; exit $p.ExitCode } catch { exit 1 }`;
}

export function launchOfficialLogin(
  provider: ProviderName,
  env = process.env,
): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    const child = spawn(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(loginScript(provider), "utf16le").toString("base64"),
      ],
      {
        cwd: homedir(),
        env,
        windowsHide: true,
        stdio: "ignore",
      },
    );
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
    child.unref();
  });
}
