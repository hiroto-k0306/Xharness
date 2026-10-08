import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { WorkflowFailure } from "./contracts.js";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";

// The supervisor alone owns the unnamed Job handle. Never inherit it into the
// child: killing the supervisor closes the last handle and kills descendants.
// Create suspended -> assign -> resume avoids the spawn-before-assignment race.
const supervisor = String.raw`
$ErrorActionPreference = 'Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.IO.Pipes;
using System.Runtime.InteropServices;
public static class XHarnessOwnedJob {
 [StructLayout(LayoutKind.Sequential)] struct Limits {
  public long ProcessTime, JobTime; public uint Flags;
  public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit;
  public UIntPtr Affinity; public uint Priority, Scheduling;
 }
 [StructLayout(LayoutKind.Sequential)] struct Io {
  public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
 }
 [StructLayout(LayoutKind.Sequential)] struct Extended {
  public Limits Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
 }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
  public int Size; public string Reserved, Desktop, Title;
  public int X,Y,XSize,YSize,XChars,YChars,Fill; public uint Flags;
  public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
 }
 [StructLayout(LayoutKind.Sequential)] struct Info {
  public IntPtr Process, Thread; public uint ProcessId, ThreadId;
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended value, int size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr pSecurity, IntPtr tSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out Info info);
 [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
 [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
 static string Quote(string s) {
  var b=new StringBuilder("\""); int slash=0;
  foreach(char c in s) {
   if(c=='\\') { slash++; continue; }
   if(c=='"') { b.Append('\\', slash*2+1); b.Append(c); }
   else { b.Append('\\',slash); b.Append(c); }
   slash=0;
  }
  b.Append('\\',slash*2); b.Append('"'); return b.ToString();
 }
 static string Locate(string program) {
  // CreateProcessW cannot execute pnpm's extensionless shell shim or a .cmd.
  if(Path.IsPathRooted(program)) {
   if(!program.EndsWith(".exe",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("executable-required");
   return program;
  }
  if(program.IndexOfAny(new[]{'\\','/'})>=0) throw new InvalidOperationException("absolute-path-required");
  string name=program.EndsWith(".exe",StringComparison.OrdinalIgnoreCase) ? program : program+".exe";
  foreach(string path in (Environment.GetEnvironmentVariable("PATH")??"").Split(';')) {
   if(!Path.IsPathRooted(path)) continue;
   string full=Path.Combine(path,name);
   if(File.Exists(full)) return Path.GetFullPath(full);
  }
  throw new Exception("Executable unavailable");
 }
 public static int Run(string program, string[] args, string cwd, string leaseName) {
  IntPtr job=IntPtr.Zero; Info child=new Info();
  using var lease=new NamedPipeClientStream(".",leaseName,PipeDirection.InOut,PipeOptions.Asynchronous);
  try {
   // A unique live pipe proves ownership before any child is created; no PID
   // lookup/kill after restart, and no window in which a reused PID is trusted.
   lease.Connect(3000); var ownerLost=lease.ReadAsync(new byte[1],0,1);
   if(ownerLost.IsCompleted) return 125;
   job=CreateJobObjectW(IntPtr.Zero,null);
   var limits=new Extended(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; no breakaway flags
   if(job==IntPtr.Zero || !SetInformationJobObject(job,9,ref limits,Marshal.SizeOf<Extended>())) return 125;
   string executable=Locate(program); var command=new StringBuilder(Quote(executable));
   foreach(string arg in args) command.Append(" ").Append(Quote(arg));
   var startup=new Startup(); startup.Size=Marshal.SizeOf<Startup>(); startup.Flags=0x100;
   startup.Input=GetStdHandle(-10); startup.Output=GetStdHandle(-11); startup.Error=GetStdHandle(-12);
   if(!CreateProcessW(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref startup,out child)) return 125;
   if(!AssignProcessToJobObject(job,child.Process) || ownerLost.IsCompleted) return 125;
   if(ResumeThread(child.Thread)==0xffffffff) return 125;
   while(WaitForSingleObject(child.Process,50)==258) {
    if(ownerLost.IsCompleted) return 125;
   }
   uint code; return GetExitCodeProcess(child.Process,out code) ? unchecked((int)code) : 125;
  } finally {
   // Also stop detached children after a successful parent's exit.
   if(job!=IntPtr.Zero) CloseHandle(job);
   // Includes a suspended process if assignment failed; never execute uncontained.
   if(child.Process!=IntPtr.Zero) { TerminateProcess(child.Process,125); CloseHandle(child.Process); }
   if(child.Thread!=IntPtr.Zero) CloseHandle(child.Thread);
  }
 }
}
'@
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PAYLOAD__')) | ConvertFrom-Json
exit [XHarnessOwnedJob]::Run($payload.program, [string[]]$payload.args, $payload.cwd, $payload.lease)
} catch { [Console]::Error.WriteLine('owned-process-containment-unavailable'); exit 125 }
`;

/** Fail closed on Windows; no taskkill, PID recovery, CLI fallback or daemon attachment. */
export function spawnOwnedProcess(
  program: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { cwd: string },
) {
  if (process.platform !== "win32")
    throw new WorkflowFailure("owned-process-platform-unsupported");
  if (options.shell) throw new WorkflowFailure("owned-process-shell-refused");
  options.signal?.throwIfAborted();
  const leaseName = `xh-owned-${randomUUID()}`;
  const payload = Buffer.from(
    JSON.stringify({ program, args, cwd: options.cwd, lease: leaseName }),
  ).toString("base64");
  const encoded = Buffer.from(
    supervisor.replace("__PAYLOAD__", payload),
    "utf16le",
  ).toString("base64");
  if (encoded.length > 29000)
    throw new WorkflowFailure("owned-process-command-limit");
  let connection: Socket | undefined;
  const lease = createServer((socket) => {
    if (connection) {
      socket.destroy();
      return;
    }
    connection = socket;
    socket.unref();
    socket.on("error", () => {});
    lease.close();
  });
  lease.listen(`\\\\.\\pipe\\${leaseName}`);
  lease.unref();
  const child = spawn(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    },
  );
  lease.on("error", () => child.kill());
  child.once("close", () => {
    connection?.destroy();
    if (lease.listening) lease.close();
  });
  return child;
}
