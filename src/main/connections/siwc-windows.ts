import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, unlink, rmdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { BoundaryError } from "./contracts.js";
import type { SiwcProtector } from "./siwc-store.js";
import type { VaultBackend } from "./siwc-vault.js";
const exec = promisify(execFile);
const aclScript = `
$ErrorActionPreference='Stop'
$path=$env:XHARNESS_VAULT_PATH
$item=Get-Item -LiteralPath $path -Force
if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unavailable' }
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
$existing=Get-Acl -LiteralPath $path
$already=$existing.AreAccessRulesProtected -and $existing.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
foreach ($rule in $existing.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
 if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow') { $already=$false }
}
if (!$already) { Set-Acl -LiteralPath $path -AclObject $acl }
$check=Get-Acl -LiteralPath $path
if (!$check.AreAccessRulesProtected -or $check.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unavailable' }
foreach ($rule in $check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
 if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow') { throw 'Unavailable' }
}
foreach ($child in Get-ChildItem -LiteralPath $path -Force) {
 if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unavailable' }
 $childAcl=Get-Acl -LiteralPath $child.FullName
 if ($childAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Unavailable' }
 foreach ($rule in $childAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -ne $sid.Value -or $rule.AccessControlType -ne 'Allow') { throw 'Unavailable' }
 }
}
`;
const moveScript = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XHarnessVaultMove {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 [return: MarshalAs(UnmanagedType.Bool)]
 public static extern bool MoveFileExW(string source,string destination,uint flags);
}
'@
if (![XHarnessVaultMove]::MoveFileExW($env:XHARNESS_VAULT_SOURCE,$env:XHARNESS_VAULT_DESTINATION,9)) { throw 'Unavailable' }
`;
async function runWindows(script: string, paths: Record<string, string>) {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "PSModulePath",
  ])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, paths);
  await exec(
    "pwsh.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { env, windowsHide: true, timeout: 15000, maxBuffer: 4096 },
  );
}
const secureDirectory = (path: string) =>
  runWindows(aclScript, { XHARNESS_VAULT_PATH: path });
const secureFile = (path: string) =>
  runWindows(
    `
$ErrorActionPreference='Stop'
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$acl=[Security.AccessControl.FileSecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
Set-Acl -LiteralPath $env:XHARNESS_VAULT_PATH -AclObject $acl
`,
    { XHARNESS_VAULT_PATH: path },
  );
export function windowsSiwcProtector(
  storage: {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
  },
  platform: string = process.platform,
): SiwcProtector {
  const available = () =>
    platform === "win32" && storage.isEncryptionAvailable();
  return {
    available,
    encrypt(value) {
      if (!available()) throw new BoundaryError("unconfigured");
      return storage.encryptString(value);
    },
    decrypt(value) {
      if (!available()) throw new BoundaryError("unconfigured");
      return storage.decryptString(value);
    },
  };
}
/** Dedicated root only. Every file is ciphertext; a lifetime lease refuses other writers. */
export function windowsSiwcBackend(
  home: string,
  secure = secureDirectory,
): VaultBackend {
  const root = join(resolve(home), "siwc-protected");
  const path = (key: string) => {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new BoundaryError("malformed");
    return join(root, `${key}.bin`);
  };
  let leased = false;
  const check = async (p: string, directory = false) => {
    const info = await lstat(p);
    if (
      info.isSymbolicLink() ||
      (directory ? !info.isDirectory() : !info.isFile())
    )
      throw new BoundaryError("unconfigured");
    return info;
  };
  return {
    async acquire() {
      if (leased || process.platform !== "win32")
        throw new BoundaryError("unconfigured");
      try {
        await check(resolve(home), true);
        await mkdir(root, { recursive: true });
        await check(root, true);
        await secure(root);
        const lock = join(root, "lease");
        await mkdir(lock); // Stale/unknown lock fails closed; do not reclaim by time.
        try {
          await secure(lock);
        } catch (e) {
          await rmdir(lock);
          throw e;
        }
        leased = true;
        return async () => {
          if (leased) {
            await rmdir(lock);
            leased = false;
          }
        };
      } catch {
        throw new BoundaryError("unconfigured");
      }
    },
    async read(key) {
      if (!leased) throw new BoundaryError("unconfigured");
      try {
        const p = path(key);
        const stat = await check(p);
        if (stat.size > 2_097_152) throw new BoundaryError("malformed");
        return await readFile(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new BoundaryError("transport");
      }
    },
    async replaceAtomic(key, encrypted) {
      if (!leased || !encrypted.length || encrypted.length > 2_097_152)
        throw new BoundaryError("unconfigured");
      const destination = path(key),
        temporary = join(root, `${randomUUID()}.tmp`);
      try {
        try {
          await check(destination);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const file = await open(temporary, "wx", 0o600);
        try {
          await secureFile(temporary);
          await file.writeFile(encrypted);
          await file.sync();
        } finally {
          await file.close();
        }
        await runWindows(moveScript, {
          XHARNESS_VAULT_SOURCE: temporary,
          XHARNESS_VAULT_DESTINATION: destination,
        }); // REPLACE_EXISTING | WRITE_THROUGH, same volume.
        // Flush the installed ciphertext handle as well (Windows FlushFileBuffers).
        const installed = await open(destination, "r+");
        try {
          await installed.sync();
        } finally {
          await installed.close();
        }
      } catch {
        throw new BoundaryError("transport");
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },
    async remove(key) {
      if (!leased) throw new BoundaryError("unconfigured");
      try {
        const p = path(key);
        await check(p);
        await unlink(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          throw new BoundaryError("transport");
      }
    },
  };
}
