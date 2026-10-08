import { Buffer } from "node:buffer";

type Port = {
  postMessage(value: unknown): void;
  on(event: "message", listener: (value: unknown) => void): unknown;
  off(event: "message", listener: (value: unknown) => void): unknown;
};
type Handler = (name: string, args: unknown[], signal: AbortSignal) => unknown;
const failure = () => new Error("managed-sdk-worker-unavailable");
const maxPending = 64;
const maxBytes = 8 * 1024 * 1024;
// Query/phase controllers enforce their own shorter deadlines. This transport
// ceiling must not truncate a 120s phase or a bounded user approval wait.

/** Bounded, pull-based RPC. Errors never carry SDK stderr, prompts or credentials. */
export class SdkWorkerRpc {
  private sequence = 0;
  private stopped = false;
  private pending = new Map<
    number,
    { resolve(value: unknown): void; reject(): void }
  >();
  private running = new Map<number, AbortController>();
  constructor(
    private port: Port,
    private handle: Handler,
    private timeoutMs = 900000,
  ) {
    port.on("message", this.receive);
  }
  call(
    name: string,
    args: unknown[] = [],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.stopped || signal?.aborted || this.pending.size >= maxPending)
      return Promise.reject(failure());
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.pending.delete(id);
      };
      const cancel = () => {
        finish();
        this.send({ kind: "cancel", id });
        reject(failure());
      };
      const timer = setTimeout(cancel, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          finish();
          resolve(value);
        },
        reject: () => {
          finish();
          reject(failure());
        },
      });
      signal?.addEventListener("abort", cancel, { once: true });
      if (!this.send({ kind: "call", id, name, args }))
        this.pending.get(id)?.reject();
    });
  }
  close() {
    if (this.stopped) return;
    this.stopped = true;
    this.port.off("message", this.receive);
    for (const pending of this.pending.values()) pending.reject();
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
  }
  private send(value: unknown) {
    try {
      if (this.stopped || Buffer.byteLength(JSON.stringify(value)) > maxBytes)
        return false;
      this.port.postMessage(value);
      return true;
    } catch {
      return false;
    }
  }
  private receive = (raw: unknown) => {
    if (this.stopped || !raw || typeof raw !== "object") return;
    const message = raw as Record<string, unknown>;
    const id = message.id;
    if (!Number.isSafeInteger(id) || (id as number) < 1) return;
    const key = id as number;
    if (message.kind === "reply") {
      const pending = this.pending.get(key);
      if (message.ok === true) pending?.resolve(message.value);
      else pending?.reject();
    } else if (message.kind === "cancel") {
      this.running.get(key)?.abort();
    } else if (message.kind === "call") {
      if (
        typeof message.name !== "string" ||
        !Array.isArray(message.args) ||
        this.running.size >= maxPending ||
        this.running.has(key)
      ) {
        this.send({ kind: "reply", id: key, ok: false });
        return;
      }
      const controller = new AbortController();
      this.running.set(key, controller);
      void Promise.resolve()
        .then(() =>
          this.handle(
            message.name as string,
            message.args as unknown[],
            controller.signal,
          ),
        )
        .then(
          (value) => {
            if (
              !controller.signal.aborted &&
              !this.send({ kind: "reply", id: key, ok: true, value })
            )
              this.send({ kind: "reply", id: key, ok: false });
          },
          () => {
            this.send({ kind: "reply", id: key, ok: false });
          },
        )
        .finally(() => this.running.delete(key));
    }
  };
}
