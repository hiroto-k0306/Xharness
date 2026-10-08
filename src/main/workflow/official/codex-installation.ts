import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

export interface CodexInstallation {
  path: string;
  package: string;
}
const helpers = [
  "codex.exe",
  "codex-code-mode-host.exe",
  "codex-command-runner.exe",
  "codex-windows-sandbox-setup.exe",
  "codex-windows-sandbox-service.exe",
];
/** Reads Windows' registered package, never launches Codex or chooses a cache by age. */
async function installedPackage(): Promise<unknown> {
  if (process.platform !== "win32" || !process.env.SystemRoot)
    throw new Error("unsupported-platform");
  const { stdout } = await promisify(execFile)(
    join(
      process.env.SystemRoot,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference='Stop'; @(Get-AppxPackage -Name OpenAI.Codex | Select-Object Name,PublisherId,InstallLocation,PackageFullName) | ConvertTo-Json -Compress",
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 16000 },
  );
  return JSON.parse(stdout);
}

export async function discoverCodexInstallation(
  readPackage: () => Promise<unknown> = installedPackage,
): Promise<CodexInstallation> {
  try {
    const raw = await readPackage();
    const packages = Array.isArray(raw) ? raw : [raw];
    if (packages.length !== 1) throw new Error("ambiguous-installation");
    const item = packages[0] as Record<string, unknown> | null;
    if (
      item?.Name !== "OpenAI.Codex" ||
      item.PublisherId !== "2p2nqsd0c76g0" ||
      typeof item.InstallLocation !== "string" ||
      !isAbsolute(item.InstallLocation) ||
      typeof item.PackageFullName !== "string" ||
      !/^OpenAI\.Codex_[\d.]+_(?:x64|arm64)__2p2nqsd0c76g0$/.test(
        item.PackageFullName,
      )
    )
      throw new Error("invalid-installation-metadata");
    const root = resolve(item.InstallLocation, "app/resources");
    if ((await realpath(root)).toLowerCase() !== root.toLowerCase())
      throw new Error("linked-installation");
    for (const name of helpers) {
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error("missing-helper");
    }
    return { path: join(root, "codex.exe"), package: item.PackageFullName };
  } catch {
    // Do not propagate shell output or user/environment values into diagnostics.
    throw new Error(
      "公式Codexの同梱CLIを登録情報から確認できません。Codexアプリのインストールを確認するか、実行パスを指定してください。自動再試行はしません。",
    );
  }
}

/** A folder explicitly selected by the user means precisely its codex.exe. */
export async function resolveCodexOverride(value: unknown): Promise<string> {
  if (typeof value !== "string" || !isAbsolute(value))
    throw new Error(
      "公式Codexの実行パスはexeまたはフォルダーの絶対パスで指定してください",
    );
  let path = resolve(value);
  try {
    if ((await lstat(path)).isDirectory()) path = join(path, "codex.exe");
    const stat = await lstat(path);
    if (
      !/\.exe$/i.test(path) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await realpath(path)).toLowerCase() !== path.toLowerCase()
    )
      throw new Error("invalid-executable");
    return path;
  } catch {
    throw new Error(
      "公式Codexの指定した実行パスが使えません。自動設定へは切り替えていません。",
    );
  }
}
