import { spawn } from "node:child_process";

export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
) {
  signal.throwIfAborted();
  return await new Promise<{
    output: string;
    isError: boolean;
    exitCode: number | null;
    stopped: boolean;
  }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let head = "";
    let tail = "";
    let total = 0;
    let stopped = false;
    const append = (chunk: string) => {
      total += chunk.length;
      if (head.length < 15000) head += chunk.slice(0, 15000 - head.length);
      tail = (tail + chunk).slice(-15000);
    };
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn(
          "taskkill",
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        killer.on("error", () => child.kill());
        killer.on("exit", (code) => {
          if (code !== 0) child.kill();
        });
      } else child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
    };
    child.on("error", () => {
      cleanup();
      reject(new Error("Process could not start"));
    });
    child.on("close", (code) => {
      cleanup();
      const output =
        total <= 15000
          ? head
          : total <= 30000
            ? head + tail.slice(30000 - total)
            : head + "\n… output truncated …\n" + tail;
      resolve({
        output: stopped ? "Process aborted or timed out\n" + output : output,
        isError: stopped || code !== 0,
        exitCode: code,
        stopped,
      });
    });
  });
}
