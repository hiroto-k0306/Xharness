import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** One input queue serves both requests and approvals; piped text is never consent. */
export class Terminal {
  private lines: string[] = [];
  private waiting?: (line: string | undefined) => void;
  private reader;
  ended = false;
  onEnd?: () => void;
  /** Control commands may cancel active work without waiting for a request prompt. */
  onLine?: (line: string) => boolean;
  constructor(
    input: Readable,
    private output: Writable,
    readonly interactive: boolean,
  ) {
    this.reader = createInterface({ input, terminal: false });
    this.reader.on("line", (line) => {
      if (this.onLine?.(line)) return;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = undefined;
        resolve(line);
      } else this.lines.push(line);
    });
    this.reader.on("close", () => {
      this.ended = true;
      this.waiting?.(undefined);
      this.waiting = undefined;
      this.onEnd?.();
    });
  }
  write(text: string) {
    this.output.write(text);
  }
  async read(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    this.write(prompt);
    if (signal?.aborted) return undefined;
    if (this.lines.length) return this.lines.shift();
    if (this.ended) return undefined;
    return new Promise((resolve) => {
      const finish = (line: string | undefined) => {
        signal?.removeEventListener("abort", cancel);
        if (this.waiting === finish) this.waiting = undefined;
        resolve(line);
      };
      const cancel = () => finish(undefined);
      this.waiting = finish;
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel();
    });
  }
  close() {
    this.reader.close();
  }
}
