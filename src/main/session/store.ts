import { createHash } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type Message } from "../core/types.js";
import { FileCheckpointStore } from "../checkpoints/store.js";
import {
  type ProviderName,
  type SessionSummary,
  type WorkspaceSummary,
} from "../../shared/ipc.js";

/** DESIGN.md §18.4。~/.xharness/ 以下の索引と履歴。electron を使わない。 */
export type StoredSession = Omit<SessionSummary, "status" | "branch"> & {
  environment?: import("../tools/environment.js").EnvironmentReport;
};

let tempSeq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 1つの JSON ファイル(索引)を安全に読み書きする。
 * - 書き込みは直列化し、一時ファイル名は書き込みごとに一意(同時保存で互いを壊さない)
 * - 一時ファイル → rename で置き換える。Windows で rename が一時的に拒否されたら少し待って再試行
 * - 壊れたファイルは上書きせず `.corrupt-<時刻>.bak` へ退避してから空で始め、警告を残す
 */
export class JsonFile<T> {
  private chain: Promise<void> = Promise.resolve();
  /** 読み込み時に見つかった問題(画面に一度だけ通知する) */
  readonly warnings: string[] = [];
  constructor(
    private readonly path: string,
    private readonly valid: (value: unknown) => value is T,
  ) {}
  async read(fallback: T): Promise<T> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (this.valid(value)) return value;
    } catch {
      /* 下で退避する */
    }
    const backup = `${this.path}.corrupt-${Date.now()}.bak`;
    await rename(this.path, backup);
    this.warnings.push(
      `${basename(this.path)} が壊れていたため ${basename(backup)} へ退避し、空の一覧から始めました`,
    );
    return fallback;
  }
  /** 呼び出した時点の内容を、前の書き込みの後に書く */
  write(value: T): Promise<void> {
    const text = JSON.stringify(value, null, 2);
    const run = this.chain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${process.pid}.${++tempSeq}.tmp`;
      await writeFile(temp, text, "utf8");
      for (let attempt = 0; ; attempt++) {
        try {
          await rename(temp, this.path);
          return;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            attempt >= 4 ||
            !["EPERM", "EBUSY", "EACCES"].includes(code ?? "")
          ) {
            await rm(temp, { force: true });
            throw error;
          }
          await sleep(25 * 2 ** attempt);
        }
      }
    });
    // 失敗しても後続の書き込みは続ける(失敗は呼び出し元へ返す)
    this.chain = run.catch(() => undefined);
    return run;
  }
}
const isArray = <T>(value: unknown): value is T[] => Array.isArray(value);

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

type WorkspaceItem = {
  remoteUrl?: string;
  id: string;
  root: string;
  name: string;
  lastOpenedAt: number;
};
/** git の状態は短時間キャッシュする(状態を送るたびに全ワークスペースを読まない) */
const GIT_CACHE_MS = 2000;

export class WorkspaceStore {
  private items: WorkspaceItem[] = [];
  private readonly file: JsonFile<WorkspaceItem[]>;
  private readonly git = new Map<
    string,
    { at: number; info: Awaited<ReturnType<typeof gitInfo>> }
  >();
  constructor(
    home: string,
    private readonly now: () => number = Date.now,
  ) {
    this.file = new JsonFile(
      join(home, "workspaces.json"),
      isArray<WorkspaceItem>,
    );
  }
  get warnings() {
    return this.file.warnings;
  }
  async load() {
    this.items = await this.file.read([]);
  }
  async add(root: string, now = Date.now(), remoteUrl?: string) {
    const abs = resolve(root);
    const id = workspaceId(abs);
    const existing = this.items.find((w) => w.id === id);
    if (existing) {
      existing.lastOpenedAt = now;
      existing.remoteUrl ??= remoteUrl;
    } else
      this.items.push({
        id,
        root: abs,
        name: basename(abs) || abs,
        lastOpenedAt: now,
        remoteUrl,
      });
    this.git.delete(abs);
    await this.file.write(this.items);
    return id;
  }
  async touch(id: string, now = Date.now()) {
    const item = this.items.find((w) => w.id === id);
    if (!item) return;
    item.lastOpenedAt = now;
    await this.file.write(this.items);
  }
  /** 一覧から外すだけ。フォルダとセッションは消さない(§16.6)。 */
  async forget(id: string) {
    this.items = this.items.filter((w) => w.id !== id);
    await this.file.write(this.items);
  }
  get(id: string) {
    return this.items.find((w) => w.id === id);
  }
  async summaries(): Promise<WorkspaceSummary[]> {
    const out: WorkspaceSummary[] = [];
    for (const w of this.items) {
      let cached = this.git.get(w.root);
      if (!cached || this.now() - cached.at > GIT_CACHE_MS) {
        cached = { at: this.now(), info: await gitInfo(w.root) };
        this.git.set(w.root, cached);
      }
      const g = cached.info;
      out.push({
        ...w,
        kind: w.remoteUrl ? "cloned" : g.git ? "git" : "no git",
        branch: g.branch,
      });
    }
    return out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }
}

export class SessionStore {
  private sessions: StoredSession[] = [];
  private readonly index: JsonFile<StoredSession[]>;
  constructor(private readonly home: string) {
    this.index = new JsonFile(
      join(home, "sessions", "index.json"),
      isArray<StoredSession>,
    );
  }
  get warnings() {
    return this.index.warnings;
  }
  private history(id: string) {
    if (!/^[\w-]+$/.test(id)) throw new Error("Invalid session id");
    return join(this.home, "sessions", `${id}.jsonl`);
  }
  async load() {
    this.sessions = await this.index.read([]);
  }
  /** 旧い索引にはモデルが無い。メモリ上だけ既定値で補う(次の保存で書かれる)。 */
  fillDefaults(defaults: { model: string; effort: StoredSession["effort"] }) {
    for (const s of this.sessions) {
      const m = s as Partial<StoredSession>;
      m.model ??= defaults.model;
      m.effort ??= defaults.effort;
    }
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
    await this.index.write(this.sessions);
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
        const message = JSON.parse(line) as Message;
        const keep = message.meta?.rewind?.keep;
        if (keep !== undefined) {
          if (Number.isSafeInteger(keep) && keep >= 0 && keep <= out.length)
            out.splice(keep);
          else {
            const warning =
              "巻き戻し位置が現在の会話範囲外または不正なため、履歴を保持しました。";
            if (!this.index.warnings.includes(warning))
              this.index.warnings.push(warning);
          }
        }
        out.push(message);
      } catch {
        /* 壊れた行は読み飛ばす */
      }
    }
    return out;
  }
  async delete(id: string) {
    await new FileCheckpointStore(this.home).remove(id);
    await rm(this.history(id), { force: true });
    this.sessions = this.sessions.filter((session) => session.id !== id);
    await this.index.write(this.sessions);
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
