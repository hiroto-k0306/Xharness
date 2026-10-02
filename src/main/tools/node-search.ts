import { readdir, readFile, lstat } from "node:fs/promises";
import {
  basename,
  dirname,
  join,
  relative,
  resolve,
  matchesGlob,
} from "node:path";
import ignore, { type Ignore } from "ignore";
import { ToolExecutionError } from "./errors.js";
import { SearchMatcher } from "./search-matcher.js";

const slash = (path: string) => path.replaceAll("\\", "/");
export function searchExcluded(path: string) {
  const name = basename(path).toLowerCase();
  return (
    name === "auth.json" ||
    name.endsWith(".credentials.json") ||
    name.startsWith(".env") ||
    /^id_(rsa|ed25519|ecdsa|dsa)(?:\.|$)/.test(name) ||
    /\.(?:pem|key)$/.test(name) ||
    [".npmrc", ".netrc", ".git-credentials"].includes(name)
  );
}
type Rules = { root: string; matcher: Ignore }[];
async function rulesIn(root: string, rules: Rules): Promise<Rules> {
  try {
    if ((await lstat(join(root, ".gitignore"))).isSymbolicLink()) return rules;
    return [
      ...rules,
      {
        root,
        matcher: ignore().add(await readFile(join(root, ".gitignore"), "utf8")),
      },
    ];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return rules;
    throw error;
  }
}
/** No symlink following: an unapproved target cannot enter a recursive search. */
export async function nodeSearch(
  cwd: string,
  target: string,
  pattern: string,
  mode: "Grep" | "Glob",
  signal: AbortSignal,
) {
  try {
    if (mode === "Grep") new RegExp(pattern, "u");
    else matchesGlob("test", pattern);
  } catch {
    throw new ToolExecutionError(
      "検索パターンが不正、またはNode検索で使えない形式です。",
      "invalid_args",
    );
  }
  const base = resolve(cwd);
  let rules: Rules = [];
  // Include root/ancestor ignore rules when the caller scopes to a subdirectory.
  const ancestors: string[] = [];
  let ancestor = dirname(target);
  while (true) {
    ancestors.unshift(ancestor);
    if (ancestor === base || dirname(ancestor) === ancestor) break;
    ancestor = dirname(ancestor);
  }
  for (const root of ancestors) rules = await rulesIn(root, rules);
  const output: string[] = [];
  let truncated = false;
  const deadline = Date.now() + 120000;
  const matcher = mode === "Grep" ? new SearchMatcher(pattern) : undefined;
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() > deadline)
      throw new ToolExecutionError("検索時間の上限に達しました。", "timeout");
  };
  const ignored = (path: string, directory: boolean, rules: Rules) => {
    let result = false;
    for (const r of rules) {
      const rel = slash(relative(r.root, path));
      if (!rel || rel.startsWith("../")) continue;
      const test = r.matcher.test(rel + (directory ? "/" : ""));
      if (test.ignored) result = true;
      else if (test.unignored) result = false;
    }
    return result;
  };
  const visit = async (
    path: string,
    rules: Rules,
    explicit = false,
  ): Promise<void> => {
    check();
    const info = await lstat(path);
    if (info.isSymbolicLink())
      throw new ToolExecutionError(
        "検索ではリンク先をたどれません。対象ファイルを直接指定してください。",
        "denied",
      );
    if (searchExcluded(path)) return;
    if (info.isDirectory()) {
      const next = await rulesIn(path, rules);
      for (const entry of (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        check();
        if (truncated) break;
        if (
          entry.isSymbolicLink() ||
          entry.name.startsWith(".") ||
          entry.name === ".git"
        )
          continue;
        const full = join(path, entry.name);
        if (searchExcluded(full) || ignored(full, entry.isDirectory(), next))
          continue;
        await visit(full, next);
      }
    } else if (info.isFile()) {
      if (!explicit && ignored(path, false, rules)) return;
      if (mode === "Glob") {
        const rel = slash(relative(target, path));
        if (
          matchesGlob(rel || basename(path), pattern) ||
          (!pattern.includes("/") && matchesGlob(basename(path), pattern))
        )
          output.push(path);
      } else {
        const bytes = await readFile(path, { signal });
        check();
        if (bytes.includes(0)) return;
        const lines = bytes.toString("utf8").split(/\r?\n/);
        for (const i of await matcher!.match(
          lines,
          251 - output.length,
          signal,
          deadline - Date.now(),
        )) {
          if (output.length === 250) {
            truncated = true;
            break;
          }
          output.push(`${path}:${i + 1}:${lines[i]}`);
        }
      }
    }
  };
  try {
    await visit(target, rules, true);
  } finally {
    await matcher?.close();
  }
  return (
    output.join("\n") +
    (truncated
      ? "\n検索結果を250件で打ち切りました。対象やパターンを絞ってください。"
      : "")
  );
}
