import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { redact } from "../../core/redact.js";
import { relativeFile, WorkflowFailure } from "./contracts.js";

const skipped = new Set([
  ".git",
  ".xharness-workspaces",
  "node_modules",
  ".tools",
  ".out",
  "dist",
  "out",
  "coverage",
  ".next",
  ".cache",
]);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export interface ProjectInventory {
  cwd: string;
  files: { path: string; hash: string; bytes: number; sample: string }[];
  tests: string[];
  fingerprint: string;
}

/** Bounded, non-executing input for scope selection. Never follows links or reads credentials. */
export async function inspectProjectInventory(
  cwd: string,
  signal: AbortSignal,
): Promise<ProjectInventory> {
  const root = resolve(cwd);
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
    throw new WorkflowFailure("linked-project-root");
  for (const name of [".claude", ".codex", ".xharness", ".mcp.json"]) {
    try {
      await lstat(join(root, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    throw new WorkflowFailure("project-native-or-harness-configuration");
  }
  const files: ProjectInventory["files"] = [];
  let entries = 0,
    total = 0,
    sampleBytes = 0;
  async function walk(directory: string, prefix: string) {
    signal.throwIfAborted();
    for (const entry of (
      await readdir(directory, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      signal.throwIfAborted();
      if (++entries > 10000)
        throw new WorkflowFailure("project-inventory-entry-limit");
      const path = prefix + entry.name;
      if (
        skipped.has(entry.name) ||
        !relativeFile.safeParse(path).success ||
        entry.isSymbolicLink()
      )
        continue;
      const full = join(directory, entry.name),
        stat = await lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        await walk(full, path + "/");
        continue;
      }
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 900000) continue;
      if (files.length >= 2000 || total + stat.size > 20000000)
        throw new WorkflowFailure("project-inventory-size-limit");
      const bytes = await readFile(full);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      if (
        text.includes("\0") ||
        redact(text) !== text ||
        /sk-(?:ant-)?[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(
          text,
        )
      )
        continue;
      total += bytes.length;
      const sample =
        sampleBytes < 24000
          ? text.slice(0, Math.min(600, 24000 - sampleBytes))
          : "";
      sampleBytes += sample.length;
      files.push({ path, hash: sha(bytes), bytes: bytes.length, sample });
    }
  }
  await walk(root, "");
  const manifest = files.find((f) => f.path === "package.json");
  let vitest = false;
  if (manifest) {
    const data = await readFile(join(root, "package.json"));
    if (sha(data) !== manifest.hash)
      throw new WorkflowFailure("project-changed-after-inspection");
    try {
      const pkg = JSON.parse(data.toString("utf8"));
      vitest =
        typeof (pkg.devDependencies?.vitest ?? pkg.dependencies?.vitest) ===
        "string";
    } catch {
      /* no inferred runner for malformed metadata */
    }
  }
  const tests = files
    .filter((f) => !/(^|\/)(fixtures?|helpers?|support)\//i.test(f.path))
    .filter(
      (f) =>
        (vitest
          ? /[.-](test|spec)\.(mjs|cjs|js|ts|tsx|mts|cts|jsx)$/
          : /[.-](test|spec)\.(mjs|cjs|js)$/
        ).test(f.path) ||
        (/(^|\/)(tests?|__tests__)\//.test(f.path) &&
          /(?:from\s*["']node:(?:test|assert)|require\s*\(\s*["']node:(?:test|assert))/.test(
            f.sample,
          )),
    )
    .map((f) => f.path)
    .filter((p) =>
      /^[A-Za-z0-9_./-]+\.(mjs|cjs|js|ts|tsx|mts|cts|jsx)$/.test(p),
    );
  const fingerprint = sha(
    Buffer.from(
      JSON.stringify(files.map(({ path, hash }) => ({ path, hash }))),
    ),
  );
  return { cwd: root, files, tests, fingerprint };
}
export async function assertInventoryUnchanged(
  inventory: ProjectInventory,
  signal: AbortSignal,
) {
  const current = await inspectProjectInventory(inventory.cwd, signal);
  if (current.fingerprint !== inventory.fingerprint)
    throw new WorkflowFailure("project-changed-after-inspection");
}
