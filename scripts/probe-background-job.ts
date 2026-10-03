import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { powershellArguments } from "../src/main/tools/powershell-command.js";
const run = promisify(execFile);
const folder = await mkdtemp(join(tmpdir(), "xh-job-membership-"));
const script = join(folder, "child.cjs");
await writeFile(script, "setTimeout(()=>{},60000);");
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const probe = `public static bool Contains(uint id, bool any) {
  IntPtr process = OpenProcess(0x1000, false, id);
  if (process == IntPtr.Zero) throw new Exception("Cannot open test child");
  try { bool member; if (!IsProcessInJob(process, any ? IntPtr.Zero : job, out member)) throw new Exception("Cannot query test child"); return member; }
  finally { CloseHandle(process); }
}
`;
const unwrapped = process.argv.includes("--unwrapped");
const shells = process.argv.slice(2).filter((arg) => arg !== "--unwrapped");
for (const pwsh of shells.length ? shells : ["pwsh"]) {
  for (const mode of ["Hidden", "NoNewWindow", "ProcessStart"]) {
    const args = quote('"' + script + '"');
    const launch =
      mode === "ProcessStart"
        ? `$info = [System.Diagnostics.ProcessStartInfo]::new(); $info.FileName = ${quote(process.execPath)}; $info.Arguments = ${args}; $info.UseShellExecute = $false; $info.CreateNoWindow = $true; $p = [System.Diagnostics.Process]::Start($info);`
        : `$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${args} ${mode === "Hidden" ? "-WindowStyle Hidden" : "-NoNewWindow"} -PassThru;`;
    const command =
      launch +
      ` @{child=$p.Id; parent=$PID; currentJob=[XHarnessBackgroundJob]::Contains($p.Id, $false); anyJob=[XHarnessBackgroundJob]::Contains($p.Id, $true); parentCurrentJob=[XHarnessBackgroundJob]::Contains($PID, $false); childParent=(Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)").ParentProcessId; pwsh=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json -Compress;`;
    const encoded = powershellArguments(command, true);
    let body = Buffer.from(encoded.at(-1)!, "base64")
      .toString("utf16le")
      .replace(
        "  public static void Finish()",
        probe + "  public static void Finish()",
      );
    if (unwrapped)
      body = body.replace(
        "  Set-Item Function:global:Start-Process ([ScriptBlock]::Create($xhStartProxy))",
        "  # Diagnostic only: bypass the Start-Process proxy.",
      );
    encoded[encoded.length - 1] = Buffer.from(body, "utf16le").toString(
      "base64",
    );
    const result = await run(pwsh, encoded, {
      windowsHide: true,
      timeout: 20000,
    });
    const info = JSON.parse(result.stdout.trim());
    let alive = false;
    try {
      process.kill(info.child, 0);
      alive = true;
      process.kill(info.child);
    } catch {}
    console.log(
      JSON.stringify({
        node: process.version,
        pwshPath: pwsh,
        unwrapped,
        mode,
        ...info,
        aliveAfterParent: alive,
        stderr: result.stderr.trim(),
      }),
    );
  }
}
await rm(script);
await rmdir(folder);
