import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const allowed = new Set([
  "text",
  "-text",
  "text=auto",
  "eol=lf",
  "eol=crlf",
  "binary",
]);
const skipped = new Set([
  ".git",
  "node_modules",
  ".tools",
  ".out",
  "dist",
  "out",
  "coverage",
  ".xharness-workspaces",
]);
const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
/** Only built-in newline/binary attributes. No macros, drivers, filters or encoding conversion. */
export function safeAttributeText(text: string) {
  if (text.includes("\0")) return false;
  return text.split(/\r?\n/).every((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return true;
    const [pattern, ...attributes] = trimmed.split(/\s+/);
    return (
      !!pattern &&
      !/^[!]|^\[attr\]|["'\\]/.test(pattern) &&
      attributes.length > 0 &&
      attributes.every((a) => allowed.has(a))
    );
  });
}
async function checkFile(root: string, path: string) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 65536
  )
    throw Error("git-attributes-not-supported");
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
    if (parent === dirname(parent) || (await lstat(parent)).isSymbolicLink())
      throw Error("linked-git-attributes");
  }
  if (!same(await realpath(path), resolve(path)))
    throw Error("linked-git-attributes");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readFile(path),
  );
  if (!safeAttributeText(text)) throw Error("git-attributes-not-supported");
}
/** Inspect tracked and newly introduced attributes before status/add/diff can interpret them. */
export async function assertSafeGitAttributes(
  cwd: string,
  tracked: string[],
  common: string,
  signal: AbortSignal,
) {
  const root = resolve(cwd);
  if (!same(await realpath(root), root))
    throw Error("linked-git-attributes-root");
  const paths = new Set<string>();
  let entries = 0;
  async function walk(dir: string) {
    signal.throwIfAborted();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      signal.throwIfAborted();
      if (++entries > 10000) throw Error("git-attributes-inspection-limit");
      const full = join(dir, entry.name);
      if (entry.name.toLowerCase() === ".gitattributes") paths.add(full);
      if (
        entry.isDirectory() &&
        !skipped.has(entry.name.toLowerCase()) &&
        !(await lstat(full)).isSymbolicLink()
      )
        await walk(full);
    }
  }
  await walk(root);
  for (const path of tracked.filter((p) =>
    /(^|[\\/])\.gitattributes$/i.test(p),
  )) {
    if (
      path
        .split(/[\\/]/)
        .some((part) => !part || part === ".." || part === ".") ||
      /^[\\/]|:/.test(path)
    )
      throw Error("unsafe-attributes-path");
    paths.add(join(root, path));
  }
  for (const path of paths) {
    signal.throwIfAborted();
    await checkFile(root, path);
  }
  const metadata = resolve(cwd, common);
  if (!same(await realpath(metadata), metadata))
    throw Error("linked-git-attributes-root");
  await checkFile(metadata, join(metadata, "info/attributes"));
}
