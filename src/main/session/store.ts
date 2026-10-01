import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type Message } from "../core/types.js";
import {
  type ProviderName,
  type SessionSummary,
  type WorkspaceSummary,
} from "../../shared/ipc.js";

/** DESIGN.md §18.4。~/.xharness/ 以下の索引と履歴。electron を使わない。 */
export type StoredSession = Omit<SessionSummary, "status" | "branch">;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
async function writeJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await rename(temp, path);
}

export function workspaceId(root: string): string {
  const normal = process.platform === "win32" ? root.toLowerCase() : root;
  return createHash("sha256").update(normal).digest("hex").slice(0, 12);
}

/** .git/HEAD を直接読む(git コマンドは呼ばない)。 */
export async function gitInfo(
  root: string,
): Promise<{ git: boolean; branch?: string }> {
  try {
    const info = await stat(join(root, ".git"));
    if (info.isFile()) return { git: true }; // worktree / submodule
    const head = (await readFile(join(root, ".git", "HEAD"), "utf8")).trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return { git: true, branch: match?.[1] ?? head.slice(0, 7) };
  } catch {
    return { git: false };
  }
}

export class WorkspaceStore {
  private items: {
    id: string;
    root: string;
    name: string;
    lastOpenedAt: number;
  }[] = [];
  constructor(private readonly home: string) {}
  private get file() {
    return join(this.home, "workspaces.json");
  }
  async load() {
    this.items = await readJson(this.file, []);
  }
  async add(root: string, now = Date.now()) {
    const abs = resolve(root);
    const id = workspaceId(abs);
    const existing = this.items.find((w) => w.id === id);
    if (existing) existing.lastOpenedAt = now;
    else
      this.items.push({
        id,
        root: abs,
        name: basename(abs) || abs,
        lastOpenedAt: now,
      });
    await mkdir(this.home, { recursive: true });
    await writeJson(this.file, this.items);
    return id;
  }
  async touch(id: string, now = Date.now()) {
    const item = this.items.find((w) => w.id === id);
    if (!item) return;
    item.lastOpenedAt = now;
    await writeJson(this.file, this.items);
  }
  /** 一覧から外すだけ。フォルダとセッションは消さない(§16.6)。 */
  async forget(id: string) {
    this.items = this.items.filter((w) => w.id !== id);
    await mkdir(this.home, { recursive: true });
    await writeJson(this.file, this.items);
  }
  get(id: string) {
    return this.items.find((w) => w.id === id);
  }
  async summaries(): Promise<WorkspaceSummary[]> {
    const out: WorkspaceSummary[] = [];
    for (const w of this.items) {
      const g = await gitInfo(w.root);
      out.push({
        ...w,
        kind: g.git ? "git" : "no git",
        branch: g.branch,
      });
    }
    return out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }
}

export class SessionStore {
  private sessions: StoredSession[] = [];
  constructor(private readonly home: string) {}
  private get index() {
    return join(this.home, "sessions", "index.json");
  }
  private history(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid session id");
    return join(this.home, "sessions", `${id}.jsonl`);
  }
  async load() {
    this.sessions = await readJson(this.index, []);
  }
  list(): StoredSession[] {
    return [...this.sessions];
  }
  get(id: string) {
    return this.sessions.find((s) => s.id === id);
  }
  async save(session: StoredSession) {
    const i = this.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) this.sessions[i] = session;
    else this.sessions.push(session);
    await mkdir(join(this.home, "sessions"), { recursive: true });
    await writeJson(this.index, this.sessions);
  }
  /** 履歴は追記のみ(§12)。redact は呼び出し側が渡す。 */
  async append(
    id: string,
    messages: Message[],
    redactText: (s: string) => string,
  ) {
    if (!messages.length) return;
    await mkdir(join(this.home, "sessions"), { recursive: true });
    const lines = messages.map((m) =>
      JSON.stringify({
        ...m,
        // reasoning(署名つき thinking など)は不透明なので書き換えない。
        content: m.content.map((b) =>
          b.type === "reasoning"
            ? b
            : JSON.parse(redactText(JSON.stringify(b))),
        ),
      }),
    );
    await appendFile(this.history(id), lines.join("\n") + "\n", "utf8");
  }
  async messages(id: string): Promise<Message[]> {
    let raw: string;
    try {
      raw = await readFile(this.history(id), "utf8");
    } catch {
      return [];
    }
    const out: Message[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Message);
      } catch {
        /* 壊れた行は読み飛ばす */
      }
    }
    return out;
  }
}

export function usedProviders(
  messages: Message[],
  base: ProviderName[] = [],
): ProviderName[] {
  const set = new Set(base);
  for (const m of messages) if (m.meta?.provider) set.add(m.meta.provider);
  return [...set];
}
