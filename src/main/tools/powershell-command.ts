/** A Windows job closes with PowerShell, also killing descendants after natural exit. */
const windowsJob = `
try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XHarnessBackgroundJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters {
    public ulong ReadOperations, WriteOperations, OtherOperations;
    public ulong ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic;
    public Counters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint length);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  static IntPtr job;
  public static void Attach() {
    job = CreateJobObject(IntPtr.Zero, null);
    var info = new Extended();
    info.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info)) || !AssignProcessToJobObject(job, GetCurrentProcess())) {
      if (job != IntPtr.Zero) CloseHandle(job);
      throw new Exception("Background process management unavailable");
    }
  }
  public static void Track(uint id) {
    // Keep the same handle across membership checking and assignment.
    IntPtr process = OpenProcess(0x101101, false, id); // quota, terminate, query, synchronize
    if (process == IntPtr.Zero) {
      if (Marshal.GetLastWin32Error() == 87) return; // Already exited.
      throw new Exception("Background process management unavailable");
    }
    try {
      bool member;
      if (!IsProcessInJob(process, job, out member) ||
          (!member && !AssignProcessToJobObject(job, process))) {
        TerminateProcess(process, 1);
        WaitForSingleObject(process, 5000);
        throw new Exception("Background process management unavailable");
      }
    } finally { CloseHandle(process); }
  }
  public static void Finish() {
    // Keep the parent alive until its job members have actually exited. Closing
    // the job on parent exit initiates termination but does not wait for it.
    int length = 1024;
    while (true) {
      IntPtr buffer = Marshal.AllocHGlobal(length);
      try {
        if (!QueryInformationJobObject(job, 3, buffer, (uint)length, IntPtr.Zero)) {
          if (Marshal.GetLastWin32Error() == 234) { length = checked(length * 2); continue; }
          throw new Exception("Background process management unavailable");
        }
        int count = Marshal.ReadInt32(buffer, 4);
        uint self = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
        bool others = false;
        for (int i = 0; i < count; i++) {
          uint id = (uint)Marshal.ReadIntPtr(buffer, 8 + i * IntPtr.Size).ToInt64();
          if (id == self) continue;
          others = true;
          IntPtr process = OpenProcess(0x101001, false, id);
          if (process == IntPtr.Zero) {
            if (Marshal.GetLastWin32Error() == 87) continue; // Already exited.
            throw new Exception("Background process management unavailable");
          }
          try {
            bool member;
            if (IsProcessInJob(process, job, out member) && member) {
              TerminateProcess(process, 1);
              if (WaitForSingleObject(process, 5000) != 0)
                throw new Exception("Background process management unavailable");
            }
          } finally { CloseHandle(process); }
        }
        if (!others) return; // Re-enumerate descendants born during termination.
      } finally { Marshal.FreeHGlobal(buffer); }
    }
  }
}
'@ -ErrorAction Stop
  [XHarnessBackgroundJob]::Attach()
  # Generate the proxy from this PowerShell's own metadata to preserve parameters.
  $xhStartMetadata = [System.Management.Automation.CommandMetadata]::new((Get-Command Microsoft.PowerShell.Management\\Start-Process))
  $xhStartProxy = [System.Management.Automation.ProxyCommand]::Create($xhStartMetadata)
  if (!$xhStartProxy.Contains('$outBuffer = $null') -or !$xhStartProxy.Contains('$scriptCmd = {& $wrappedCmd @PSBoundParameters }')) {
    throw 'Background process management unavailable'
  }
  $xhStartProxy = $xhStartProxy.Replace('$outBuffer = $null', '$xhPassThru = $PSBoundParameters.ContainsKey("PassThru") -and $PSBoundParameters["PassThru"]; $PSBoundParameters["PassThru"] = $true; $outBuffer = $null')
  $xhStartProxy = $xhStartProxy.Replace('$scriptCmd = {& $wrappedCmd @PSBoundParameters }', @'
$scriptCmd = { & $wrappedCmd @PSBoundParameters | ForEach-Object {
  try { [XHarnessBackgroundJob]::Track($_.Id) }
  catch { [Console]::Error.WriteLine('起動した子プロセスを管理できませんでした。'); exit 1 }
  if ($xhPassThru) { $_ }
} }
'@)
  Set-Item Function:global:Start-Process ([ScriptBlock]::Create($xhStartProxy))
} catch {
  [Console]::Error.WriteLine('バックグラウンド処理の管理を開始できませんでした。')
  exit 1
}
`;
export function powershellArguments(command: string, background = false) {
  const script =
    background && process.platform === "win32"
      ? windowsJob +
        "\ntry {\n" +
        command +
        "\n} finally {\ntry { [XHarnessBackgroundJob]::Finish() } catch { [Console]::Error.WriteLine('バックグラウンド処理の終了を確認できませんでした。'); exit 1 }\n}"
      : command;
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}
