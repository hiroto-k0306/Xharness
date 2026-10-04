import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { resolveCli } from "./tools/environment.js";

/** Windows のローカル絶対 file URL のみ。URL の寛容な補正に任せない。 */
export function localFilePath(raw: unknown): string | undefined {
  if (
    typeof raw !== "string" ||
    raw.length > 8192 ||
    !/^file:\/\/\/[a-z]:\//i.test(raw) ||
    /[\\\u0000-\u0020\u007f?#]/u.test(raw) ||
    /%(?:2f|5c)/i.test(raw)
  )
    return undefined;
  try {
    const url = new URL(raw);
    if (url.host || url.search || url.hash) return undefined;
    // 構文を正規化する前に dot segment も拒否する。
    const decoded = decodeURIComponent(raw.slice(8));
    if (!safeLocalPath(decoded.replaceAll("/", "\\"))) return undefined;
    return fileURLToPath(url, { windows: true });
  } catch {
    return undefined;
  }
}

export function safeLocalPath(path: string): boolean {
  if (!/^[a-z]:\\/i.test(path)) return false;
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069<>"|?*]/u.test(path))
    return false;
  return path
    .slice(3)
    .split("\\")
    .every(
      (part, index, parts) =>
        (!part && index === parts.length - 1) ||
        (!!part &&
          !/[.: ]$/.test(part) &&
          !part.includes(":") &&
          !/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(
            part,
          )),
    );
}

const run = promisify(execFile);
/** UNCだけでなく割り当てられたネットワークドライブも拒否。照会失敗は拒否。 */
export async function isLocalDrive(path: string): Promise<boolean> {
  if (process.platform !== "win32" || !safeLocalPath(path)) return false;
  try {
    // 未解決名を起動すると Windows が CWD の exe を PATH より先に選び得る。
    const shell = await resolveCli("pwsh");
    if (!shell || !isAbsolute(shell)) return false;
    // 引数に使うのは検証済みのドライブ文字だけ。任意のパス・コマンドは挿入しない。
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class XHarnessDrive { [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern uint GetDriveType(string root); }'; [XHarnessDrive]::GetDriveType('${path.slice(0, 3)}')`;
    const result = await run(
      shell,
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4096,
      },
    );
    // DRIVE_REMOVABLE / FIXED / CDROM / RAMDISK のみ。REMOTE / UNKNOWN は拒否。
    return /^(?:2|3|5|6)$/.test(result.stdout.trim());
  } catch {
    return false;
  }
}

type Snapshot = { path: string; directory: boolean; identity: string };
export interface LocalLinkHost {
  confirm(
    path: string,
    directory: boolean,
  ): Promise<"open" | "folder" | "cancel">;
  open(path: string): Promise<string>;
  reveal(path: string): void;
  active(): boolean;
}
export class LocalLinks {
  private busy = false;
  constructor(
    private readonly host: LocalLinkHost,
    private readonly localDrive = isLocalDrive,
    private readonly resolvePath: (path: string) => Promise<string> = realpath,
    private readonly inspect: (path: string) => Promise<Stats> = stat,
  ) {}

  private async validate(path: string): Promise<Snapshot | undefined> {
    if (!safeLocalPath(path) || !(await this.localDrive(path))) return;
    const resolved = await this.resolvePath(path);
    if (!safeLocalPath(resolved) || !(await this.localDrive(resolved))) return;
    const info = await this.inspect(resolved);
    if (!info.isFile() && !info.isDirectory()) return;
    return {
      path: resolved,
      directory: info.isDirectory(),
      identity: [
        info.dev,
        info.ino,
        info.size,
        info.mtimeMs,
        info.ctimeMs,
      ].join(":"),
    };
  }

  async handle(raw: unknown, userGesture: boolean): Promise<boolean> {
    const path = localFilePath(raw);
    if (!path || !userGesture || this.busy || !this.host.active()) return false;
    this.busy = true;
    try {
      const before = await this.validate(path);
      if (!before || !this.host.active()) return false;
      const choice = await this.host.confirm(before.path, before.directory);
      if (choice !== "open" && choice !== "folder") return false;
      if (!this.host.active()) return false;
      // 確認中のリンク先・ファイルの差し替えは承認を流用しない。
      const after = await this.validate(path);
      if (
        !after ||
        before.path !== after.path ||
        before.directory !== after.directory ||
        before.identity !== after.identity ||
        !this.host.active()
      )
        return false;
      if (choice === "folder" && !after.directory) {
        this.host.reveal(after.path);
        return true;
      }
      return (await this.host.open(after.path)) === "";
    } catch {
      // OS のエラー文字列(パスなど)は renderer・ログへ転送しない。
      return false;
    } finally {
      this.busy = false;
    }
  }
}
