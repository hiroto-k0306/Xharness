import { mkdir, readFile } from "node:fs/promises";
import { appendDurableLog } from "./durable-log.js";
import { join } from "node:path";
import { type Receipt } from "../../shared/ipc.js";
import { traceJson } from "../core/trace.js";
export class ReceiptStore {
  private chains = new Map<string, Promise<void>>();
  constructor(private readonly home: string) {}
  private path(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid session id");
    return join(this.home, "receipts", `${id}.jsonl`);
  }
  async read(id: string): Promise<Receipt[]> {
    try {
      const receipts = (await readFile(this.path(id), "utf8"))
        .split(/\r?\n/)
        .flatMap((line) => {
          try {
            const r = JSON.parse(line) as Receipt;
            return r.sessionId === id && typeof r.id === "string" ? [r] : [];
          } catch {
            return [];
          }
        });
      return [...new Map(receipts.map((r) => [r.id, r])).values()];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  async append(
    id: string,
    receipts: Receipt[],
    clean: (text: string) => string,
  ) {
    if (!receipts.length) return;
    const path = this.path(id);
    const text = receipts.map((r) => traceJson(r, clean)).join("\n") + "\n";
    const job = (this.chains.get(id) ?? Promise.resolve()).then(async () => {
      await mkdir(join(this.home, "receipts"), { recursive: true });
      await appendDurableLog(path, text);
    });
    this.chains.set(
      id,
      job.catch(() => undefined),
    );
    return job;
  }
}
