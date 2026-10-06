import { readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { JsonFile } from "../session/store.js";
import type { IntentLedger } from "./boundary.js";
import { BoundaryError, type Action, type Scope } from "./contracts.js";

type Record = {
  key: string;
  fingerprint: string;
  state: "pending" | "completed";
};
const tails = new Map<string, Promise<void>>();
const valid = (value: unknown): value is Record[] =>
  Array.isArray(value) &&
  value.every(
    (r) =>
      !!r &&
      typeof r === "object" &&
      typeof r.key === "string" &&
      typeof r.fingerprint === "string" &&
      ["pending", "completed"].includes(r.state),
  ) &&
  new Set(value.map((r) => r.key)).size === value.length;
/** Use only while holding acquireHomeWriter(home). Corruption fails closed, never empty-reset. */
export class FileIntentLedger implements IntentLedger {
  private path: string;
  constructor(home: string, sessionId: string) {
    if (!/^[\w-]+$/.test(sessionId)) throw new BoundaryError("malformed");
    this.path = join(resolve(home), "connection-intents", `${sessionId}.json`);
  }
  private async transaction<T>(run: (records: Record[]) => Promise<T>) {
    const key =
      process.platform === "win32" ? this.path.toLowerCase() : this.path;
    const previous = tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((r) => {
      release = r;
    });
    tails.set(key, tail);
    await previous;
    try {
      let records: unknown = [];
      try {
        records = JSON.parse(await readFile(this.path, "utf8"));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT")
          throw new BoundaryError("uncertain");
      }
      if (!valid(records)) throw new BoundaryError("uncertain");
      return await run(records);
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }
  private key(scope: Scope, action: Action) {
    return JSON.stringify([scope.taskId, scope.sessionId, action.id]);
  }
  private fingerprint(action: Action) {
    return createHash("sha256").update(JSON.stringify(action)).digest("hex");
  }
  private async save(records: Record[]) {
    await mkdir(dirname(this.path), { recursive: true });
    await new JsonFile(this.path, valid).write(records);
  }
  claim(scope: Scope, action: Action) {
    return this.transaction(async (records) => {
      const key = this.key(scope, action);
      if (records.some((r) => r.key === key || r.state === "pending"))
        return false;
      records.push({
        key,
        fingerprint: this.fingerprint(action),
        state: "pending",
      });
      await this.save(records);
      return true;
    });
  }
  assertSettled() {
    return this.transaction(async (records) => {
      if (records.some((r) => r.state === "pending"))
        throw new BoundaryError("uncertain");
    });
  }
  complete(scope: Scope, action: Action) {
    return this.transaction(async (records) => {
      const record = records.find((r) => r.key === this.key(scope, action));
      if (
        !record ||
        record.state !== "pending" ||
        record.fingerprint !== this.fingerprint(action)
      )
        throw new BoundaryError("uncertain");
      record.state = "completed";
      await this.save(records);
    });
  }
}
