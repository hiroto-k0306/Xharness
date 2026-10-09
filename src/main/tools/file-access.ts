/** Shared canonical-path and snapshot protection used by configuration and checkpoints. */
import { createHash } from "node:crypto";
import { readFile, stat, realpath } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";

export interface Snapshot {
  hash: string;
  modifiedAt: string;
}
export class FileAccess {
  readonly reads = new Map<string, Snapshot>();
  constructor(readonly cwd: string) {}
  async path(input: string): Promise<string> {
    const absolute = resolve(this.cwd, input);
    if (
      ["auth.json", ".credentials.json"].includes(
        basename(absolute).toLowerCase(),
      )
    )
      throw new Error("Credential files are unavailable to tools");
    // Canonical paths bind the read receipt to the actual target, including symlinks.
    try {
      const canonical = await realpath(absolute);
      if (
        ["auth.json", ".credentials.json"].includes(
          basename(canonical).toLowerCase(),
        )
      )
        throw new Error("Credential files are unavailable to tools");
      return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(absolute);
      if (parent === absolute) throw error;
      return resolve(await this.path(parent), basename(absolute));
    }
  }
  async snapshot(path: string): Promise<Snapshot> {
    const bytes = await readFile(path);
    const info = await stat(path);
    return {
      hash: createHash("sha256").update(bytes).digest("hex"),
      modifiedAt: info.mtime.toISOString(),
    };
  }
  async check(path: string): Promise<string | undefined> {
    let current: Snapshot;
    try {
      current = await this.snapshot(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.reads.has(path)
          ? "File disappeared; Read again before editing"
          : undefined;
      throw error;
    }
    const previous = this.reads.get(path);
    if (!previous) return "Read the existing file before writing or editing";
    if (
      previous.hash !== current.hash ||
      previous.modifiedAt !== current.modifiedAt
    )
      return "File changed; Read again before editing";
  }
}

export type Args = Record<string, unknown>;
export function argumentsObject(value: unknown): Args {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Arguments must be an object");
  return value as Args;
}
export function stringArg(args: Args, key: string): string {
  if (typeof args[key] !== "string") throw new Error(`Invalid ${key}`);
  return args[key];
}
