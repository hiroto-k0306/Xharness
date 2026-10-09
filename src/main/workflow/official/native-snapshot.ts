import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { digest } from "./runtime.js";
import { relativeFile, WorkflowFailure } from "./contracts.js";

type FileState = { hash: string; text?: string };
export type NativeSnapshot = { head: string; files: Map<string, FileState> };
/** A file-content baseline, not a Git cleanliness check or a rollback promise. */
export async function nativeSnapshot(
  cwd: string,
  signal: AbortSignal,
): Promise<NativeSnapshot> {
  const root = await realpath(cwd);
  if (root.toLowerCase() !== resolve(cwd).toLowerCase())
    throw new WorkflowFailure("linked-workspace");
  const files = new Map<string, FileState>();
  let bytes = 0;
  async function walk(dir: string, depth: number) {
    signal.throwIfAborted();
    if (depth > 40) throw new WorkflowFailure("snapshot-limit");
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (
        [
          ".git",
          "node_modules",
          ".xharness-workspaces",
          "XHarness-workspaces",
          ".out",
          "out",
          "dist",
          "coverage",
          ".tools",
        ].includes(item.name)
      )
        continue;
      const path = join(dir, item.name),
        rel = relative(root, path).replaceAll("\\", "/");
      if (!relativeFile.safeParse(rel).success) continue;
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(path, depth + 1);
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) continue;
      if (
        files.size >= 10000 ||
        stat.size > 8 * 1024 * 1024 ||
        bytes + stat.size > 128 * 1024 * 1024
      )
        throw new WorkflowFailure("snapshot-limit");
      const data = await readFile(path);
      bytes += data.length;
      let text: string | undefined;
      try {
        if (!data.includes(0))
          text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        /* binary review reports hashes */
      }
      files.set(rel, {
        hash: createHash("sha256").update(data).digest("hex"),
        text,
      });
    }
  }
  await walk(root, 0);
  return {
    head: digest(
      [...files]
        .map(([path, f]) => [path, f.hash])
        .sort(([a], [b]) => a!.localeCompare(b!)),
    ),
    files,
  };
}
/** Review only changes since this request; preexisting edits are the baseline. */
export function nativeDiff(before: NativeSnapshot, after: NativeSnapshot) {
  const files = [...new Set([...before.files.keys(), ...after.files.keys()])]
    .sort()
    .filter((p) => before.files.get(p)?.hash !== after.files.get(p)?.hash);
  const diff = files.map((path) => {
    const a = before.files.get(path),
      b = after.files.get(path);
    return {
      path,
      beforeHash: a?.hash,
      afterHash: b?.hash,
      before: a?.text ?? (a ? "[binary]" : null),
      after: b?.text ?? (b ? "[binary]" : null),
    };
  });
  if (Buffer.byteLength(JSON.stringify(diff)) > 4 * 1024 * 1024)
    throw new WorkflowFailure("review-snapshot-limit");
  return { files, diff };
}
