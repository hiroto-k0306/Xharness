import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { BackgroundOutput } from "./background-output.js";
import { ToolExecutionError, structuredFailure } from "./errors.js";

type State =
  "running" | "completed" | "failed" | "killed" | "timeout" | "aborted";
interface Shell {
  child: ChildProcess;
  output: BackgroundOutput;
  state: State;
  exitCode: number | null;
  done: Promise<void>;
  stop?: Promise<void>;
  changed: Set<() => void>;
}

/** One registry/agent owns these opaque IDs; cleared at every turn boundary. */
export class BackgroundShells {
  private static active = 0;
  private readonly shells = new Map<string, Shell>();
  async start(
    command: string,
    args: string[],
    cwd: string,
    signal: AbortSignal,
    timeoutMs?: number,
  ) {
    signal.throwIfAborted();
    if (BackgroundShells.active >= 5)
      throw new ToolExecutionError(
        "バックグラウンド実行は同時に5件までです。既存の処理を停止するか、終了を待ってください。",
        "invalid_args",
      );
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const shellId = randomUUID();
    BackgroundShells.active++;
    let counted = true;
    let finish!: () => void;
    const shell: Shell = {
      child,
      output: new BackgroundOutput(),
      state: "running",
      exitCode: null,
      changed: new Set(),
      done: new Promise((r) => {
        finish = r;
      }),
    };
    this.shells.set(shellId, shell);
    const notify = () => {
      for (const change of shell.changed) change();
    };
    const append = (text: string) => {
      shell.output.append(text);
      notify();
    };
    child.stdout!.setEncoding("utf8").on("data", append);
    child.stderr!.setEncoding("utf8").on("data", append);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      void this.stop(shell, "aborted");
    };
    const cleanup = () => {
      if (counted) {
        BackgroundShells.active--;
        counted = false;
      }
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      notify();
      finish();
    };
    child.once("close", (code) => {
      shell.exitCode = code;
      if (shell.state === "running")
        shell.state = code === 0 ? "completed" : "failed";
      cleanup();
    });
    // Install error handling before awaiting spawn; never retain raw exceptions.
    child.on("error", () => {
      shell.state = "failed";
      cleanup();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", (error: NodeJS.ErrnoException) =>
          reject(
            new ToolExecutionError(
              "バックグラウンド処理を起動できませんでした。",
              error.code === "ENOENT"
                ? "missing_cli"
                : structuredFailure(error).kind,
            ),
          ),
        );
      });
    } catch (error) {
      this.shells.delete(shellId);
      throw error;
    }
    signal.addEventListener("abort", abort, { once: true });
    if (timeoutMs !== undefined)
      timer = setTimeout(() => {
        void this.stop(shell, "timeout");
      }, timeoutMs);
    if (signal.aborted) await this.stop(shell, "aborted");
    return { shellId, status: shell.state };
  }
  private get(shellId: string) {
    const shell = this.shells.get(shellId);
    if (!shell)
      throw new ToolExecutionError(
        "このターンで起動したshellIdが見つかりません。",
        "not_found",
      );
    return shell;
  }
  async output(
    shellId: string,
    signal: AbortSignal,
    waitMs = 0,
    clean?: (s: string) => string,
  ) {
    signal.throwIfAborted();
    const shell = this.get(shellId);
    if (waitMs && shell.state === "running" && !shell.output.pending) {
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(
            new ToolExecutionError("出力の待機を中断しました。", "aborted"),
          );
        };
        const timer = setTimeout(done, Math.min(60000, waitMs));
        const cleanup = () => {
          clearTimeout(timer);
          shell.changed.delete(done);
          signal.removeEventListener("abort", abort);
        };
        shell.changed.add(done);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    return {
      shellId,
      status: shell.state,
      exitCode: shell.exitCode,
      ...shell.output.read(clean),
    };
  }
  private async stop(shell: Shell, state: State) {
    if (shell.stop) return shell.stop;
    if (shell.state !== "running") return;
    shell.state = state;
    shell.stop = (async () => {
      const pid = shell.child.pid;
      if (pid && process.platform === "win32") {
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("error", () => {
            shell.child.kill();
            resolve();
          });
          killer.once("close", (code) => {
            if (code !== 0) shell.child.kill();
            resolve();
          });
        });
      } else if (pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          shell.child.kill("SIGKILL");
        }
      }
      await shell.done;
    })();
    return shell.stop;
  }
  async kill(shellId: string) {
    const shell = this.get(shellId);
    await this.stop(shell, "killed");
    return { shellId, status: shell.state };
  }
  waitForExit(shellId: string) {
    return this.get(shellId).done;
  }
  async endTurn() {
    await Promise.all(
      [...this.shells.values()].map((shell) => this.stop(shell, "killed")),
    );
    this.shells.clear();
  }
}
