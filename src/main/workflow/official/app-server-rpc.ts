import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { runtimeEnvironment } from "./workspace.js";
import { WorkflowFailure } from "./contracts.js";
import { object } from "./usage.js";
export interface AppServerPort {
  request(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  notify(method: string, params: unknown): void;
  subscribe(
    listener: (method: string, params: Record<string, unknown>) => void,
  ): () => void;
  approve(
    handler: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ): void;
  close(): void;
}
/** Dedicated official stdio process. No daemon attachment, token extraction, stdout or stderr logging. */
export class AppServerRpc implements AppServerPort {
  #child: ChildProcessWithoutNullStreams;
  #sequence = 0;
  #buffer = "";
  #closed = false;
  #listeners = new Set<
    (method: string, params: Record<string, unknown>) => void
  >();
  #handler?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
  #pending = new Map<
    number,
    { resolve(v: unknown): void; reject(e: Error): void; cleanup(): void }
  >();
  constructor(executable: string, cwd: string) {
    this.#child = spawn(
      executable,
      [
        "app-server",
        "--stdio",
        ...[
          "multi_agent",
          "multi_agent_v2",
          "hooks",
          "apps",
          "plugins",
          "remote_plugin",
          "computer_use",
          "browser_use",
          "browser_use_external",
          "code_mode_host",
          "skill_search",
          "skill_mcp_dependency_install",
          "tool_suggest",
        ].flatMap((name) => ["--disable", name]),
      ],
      {
        cwd,
        windowsHide: true,
        env: runtimeEnvironment(),
        stdio: "pipe",
      },
    );
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      if (this.#buffer.length > 2000000) {
        this.close();
        return;
      }
      let newline: number;
      while ((newline = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        if (line.length > 1000000) {
          this.close();
          return;
        }
        try {
          void this.#message(object(JSON.parse(line))).catch(() =>
            this.close(),
          );
        } catch {
          this.close();
        }
      }
    });
    this.#child.stderr.resume();
    this.#child.once("error", () => this.close());
    this.#child.once("close", () => this.close());
  }
  #write(value: unknown) {
    if (this.#closed) throw new WorkflowFailure("app-server-closed");
    this.#child.stdin.write(JSON.stringify(value) + "\n", (e) => {
      if (e) this.close();
    });
  }
  async #message(message: Record<string, unknown>) {
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        if (!this.#handler)
          this.#write({
            id: message.id,
            error: { code: -32601, message: "Unsupported workflow request" },
          });
        else {
          try {
            const result = await this.#handler(
              message.method,
              object(message.params),
            );
            if (!this.#closed) this.#write({ id: message.id, result });
          } catch {
            if (!this.#closed)
              this.#write({
                id: message.id,
                error: {
                  code: -32601,
                  message: "Unsupported workflow request",
                },
              });
          }
        }
      } else
        for (const listener of this.#listeners)
          listener(message.method, object(message.params));
    } else if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      pending.cleanup();
      if (message.error !== undefined)
        pending.reject(new WorkflowFailure("app-server-request-failed"));
      else pending.resolve(message.result);
    }
  }
  request(
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.#closed || signal.aborted) {
        reject(new WorkflowFailure("cancelled"));
        return;
      }
      const id = ++this.#sequence;
      const cancel = () => {
        this.#pending.delete(id);
        cleanup();
        reject(new WorkflowFailure("cancelled"));
      };
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        cleanup();
        reject(new WorkflowFailure("app-server-timeout"));
      }, 60000);
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
      };
      signal.addEventListener("abort", cancel, { once: true });
      this.#pending.set(id, { resolve, reject, cleanup });
      try {
        this.#write({ id, method, params });
      } catch {
        cancel();
      }
    });
  }
  notify(method: string, params: unknown) {
    this.#write({ method, params });
  }
  subscribe(
    listener: (method: string, params: Record<string, unknown>) => void,
  ) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  approve(
    handler: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {
    this.#handler = handler;
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(new WorkflowFailure("app-server-closed"));
    }
    this.#pending.clear();
    this.#listeners.clear();
    this.#child.stdin.destroy();
    this.#child.kill();
  }
}
