import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { powershellArguments } from "./powershell-command.js";
import { cliAvailable } from "./environment.js";

const hasPwsh = process.platform === "win32" && (await cliAvailable("pwsh"));
const run = promisify(execFile);
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";

it.skipIf(!hasPwsh).each(["Hidden", "NoNewWindow"])(
  "registers Start-Process %s in this specific Job before returning",
  async (mode) => {
    const script = `$p = Start-Process -FilePath ${quote(process.execPath)} -ArgumentList @('-e','setTimeout(()=>{},60000)') ${mode === "Hidden" ? "-WindowStyle Hidden" : "-NoNewWindow"} -PassThru; [XHarnessBackgroundJob]::Probe($p.Id); $p.Id;`;
    const args = powershellArguments(script, true);
    // Diagnostic only: access the wrapper's specific Job, not merely any Job.
    const probe = `public static bool Probe(uint id) {
      IntPtr process = OpenProcess(0x1000, false, id);
      if (process == IntPtr.Zero) throw new Exception("Cannot open test child");
      try { bool member; if (!IsProcessInJob(process, job, out member)) throw new Exception("Cannot query test child"); return member; }
      finally { CloseHandle(process); }
    }
    `;
    args[args.length - 1] = Buffer.from(
      Buffer.from(args.at(-1)!, "base64")
        .toString("utf16le")
        .replace(
          "  public static void Finish()",
          probe + "  public static void Finish()",
        ),
      "utf16le",
    ).toString("base64");
    let pid = 0;
    try {
      const result = await run("pwsh", args, {
        windowsHide: true,
        timeout: 15000,
      });
      const lines = result.stdout.trim().split(/\r?\n/);
      pid = Number(lines.at(-1));
      expect(lines[0]).toBe("True");
      expect(result.stderr).toBe("");
      expect(pid).toBeGreaterThan(0);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      if (pid)
        try {
          process.kill(pid);
        } catch {
          /* Already exited. */
        }
    }
  },
  20000,
);

it.skipIf(!hasPwsh)(
  "preserves Start-Process output without PassThru, WhatIf and named arguments",
  async () => {
    const folder = await mkdtemp(join(tmpdir(), "xh-start-proxy-"));
    const script = join(folder, "child.cjs"),
      ids = join(folder, "pid.txt");
    await writeFile(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(ids)},String(process.pid));setTimeout(()=>{},60000);`,
    );
    let pid = 0;
    try {
      const command = `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote('"' + script + '"')} -WorkingDirectory ${quote(folder)} -WindowStyle Hidden; while (!(Test-Path ${quote(ids)})) { Start-Sleep -Milliseconds 20 }`;
      const result = await run("pwsh", powershellArguments(command, true), {
        windowsHide: true,
        timeout: 15000,
      });
      pid = Number(await readFile(ids, "utf8"));
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(() => process.kill(pid, 0)).toThrow();
      await rm(ids);
      const whatIf = await run(
        "pwsh",
        powershellArguments(
          command
            .replace("-WindowStyle Hidden", "-WindowStyle Hidden -WhatIf")
            .split("; while")[0]!,
          true,
        ),
        { windowsHide: true, timeout: 15000 },
      );
      expect(whatIf.stderr).toBe("");
      await expect(readFile(ids)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (pid)
        try {
          process.kill(pid);
        } catch {
          /* Already exited. */
        }
    }
  },
  30000,
);
