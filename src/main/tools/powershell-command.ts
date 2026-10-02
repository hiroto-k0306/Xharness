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
}
'@ -ErrorAction Stop
  [XHarnessBackgroundJob]::Attach()
} catch {
  [Console]::Error.WriteLine('バックグラウンド処理の管理を開始できませんでした。')
  exit 1
}
`;
export function powershellArguments(command: string, background = false) {
  const script =
    background && process.platform === "win32"
      ? windowsJob + "\n" + command
      : command;
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}
