import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { redact } from "../core/redact.js";
import {
  type SessionStore,
  type WorkspaceStore,
  type StoredSession,
} from "../session/store.js";

const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Nearest repository identity, including linked worktrees; never invoke git. */
async function repository(directory: string): Promise<string | undefined> {
  for (let path = directory; ; path = dirname(path)) {
    try {
      const marker = join(path, ".git");
      const info = await stat(marker);
      let git = marker;
      if (info.isFile()) {
        if (info.size > 4096) throw new Error("Invalid git marker");
        const match = /^gitdir: (.+)\s*$/.exec(
          (await readFile(marker, "utf8")).trim(),
        );
        if (!match) throw new Error("Invalid git marker");
        git = resolve(path, match[1]!);
      } else if (!info.isDirectory()) throw new Error("Invalid git marker");
      git = await realpath(git);
      try {
        const common = join(git, "commondir");
        if ((await stat(common)).size > 4096)
          throw new Error("Invalid git common directory");
        git = await realpath(
          resolve(git, (await readFile(common, "utf8")).trim()),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return git;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (dirname(path) === path) return undefined;
  }
}

/** Do not expose tool blocks, reasoning, arbitrary metadata or credential lines. */
export function historyText(
  text: string,
  clean: (text: string) => string,
): string {
  const safe = redact(clean(text));
  let privateKey = false;
  return safe
    .split(/\r?\n/)
    .map((line) => {
      if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) privateKey = true;
      if (privateKey) {
        if (/-----END .*PRIVATE KEY-----/.test(line)) privateKey = false;
        return "[credential-like line omitted]";
      }
      return /(?:password|passwd|secret|token|authorization|api[_ -]?key|account[_ -]?id)\s*["']?\s*[:=]|\bBearer\s+|\b(?:sk-|gh[pousr]_|github_pat_|AKIA)[A-Za-z0-9_-]+/i.test(
        line,
      )
        ? "[credential-like line omitted]"
        : line;
    })
    .join("\n");
}

export interface HistoryScope {
  home: string;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  sessionId: string;
  workspaceId: string | null;
  cwd: string;
  clean: (text: string) => string;
}
/** Pin the project's real identity before reading saved evidence. */
export function projectHistoryAccess(scope: HistoryScope) {
  const pin = (async () => {
    const workspace =
      scope.workspaceId && scope.workspaces.get(scope.workspaceId);
    if (!workspace) return undefined;
    const home = await realpath(scope.home);
    const root = await realpath(workspace.root);
    // Legacy metadata has no historical symlink target: fail closed for aliased roots.
    if (!same(root, resolve(workspace.root))) return undefined;
    return { home, root, git: await repository(root) };
  })().catch(() => undefined);
  const eligible = async (session?: StoredSession, includeCurrent = false) => {
    const pinned = await pin;
    const workspace =
      session?.workspaceId && scope.workspaces.get(session.workspaceId);
    const source = scope.workspaceId && scope.workspaces.get(scope.workspaceId);
    if (
      !pinned ||
      !workspace ||
      !source ||
      !session ||
      !Number.isFinite(new Date(session.createdAt).getTime()) ||
      !Number.isFinite(new Date(session.updatedAt).getTime()) ||
      (session.id === scope.sessionId && !includeCurrent)
    )
      return false;
    try {
      if (
        !same(await realpath(scope.home), pinned.home) ||
        !same(await realpath(source.root), pinned.root) ||
        !same(await realpath(workspace.root), pinned.root) ||
        !same(resolve(workspace.root), pinned.root)
      )
        return false;
      const rootGit = await repository(pinned.root);
      if (
        pinned.git
          ? !rootGit || !same(rootGit, pinned.git)
          : rootGit !== undefined
      )
        return false;
      for (const directory of [scope.cwd, session.cwd]) {
        const cwd = await realpath(directory);
        const git = await repository(cwd);
        if (
          pinned.git
            ? !git || !same(git, pinned.git)
            : git !== undefined || !inside(pinned.root, cwd)
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  return { pin, eligible };
}
