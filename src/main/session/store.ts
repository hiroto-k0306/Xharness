import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  open,
  realpath,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { type Message } from "../core/types.js";
import { appendDurableLog } from "./durable-log.js";
import { readTraceReplay } from "./report-trace.js";
import { FileCheckpointStore } from "../checkpoints/store.js";
import {
  type ProviderName,
  type SessionSummary,
  type WorkspaceSummary,
} from "../../shared/ipc.js";

/** DESIGN.md §18.4。~/.xharness/ 以下の索引と履歴。electron を使わない。 */
export type StoredSession = Omit<SessionSummary, "status" | "branch"> & {
  /** Explicit next-workflow skill selections. Source pins only; no bodies. */
  officialSkills?: import("../../shared/official-skills.js").OfficialSkillSelection[];
  /** Fingerprint only; no system text, tools, credentials or permissions. */
  premiseHash?: string;
  /** 未指定は旧systemを維持する。新規会話だけ共通リンク指示を使う。 */
  fileLinkGuidanceVersion?: 1;
  environment?: import("../tools/environment.js").EnvironmentReport;
};

let tempSeq = 0;
export const RECOVERY_NOTICE =
  "前回の保存が未確定です。外部副作用を再実行しないため、この会話の実行を停止しています。HTMLレポートで記録を確認し、新しいセッションを使用してください。";
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
      const file = await open(temp, "w");
      try {
        await file.writeFile(text, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
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
  private readonly deleted = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  /** History writes and deletion share one per-session queue. */
  private write(id: string, run: () => Promise<void>): Promise<void> {
    const next = (this.writes.get(id) ?? Promise.resolve()).then(run);
    const tail = next.catch(() => undefined);
    this.writes.set(id, tail);
    void tail.then(() => {
      if (this.writes.get(id) === tail) this.writes.delete(id);
    });
    return next;
  }
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
    this.sessions = (await this.index.read([])).filter(
      (s) => !this.deleted.has(s.id),
    );
    for (const session of this.sessions)
      await this.recoverEvaluation(session.id);
  }
  /** Repair identity from passive logs only. Never replay providers, commands or tools. */
  private async recoverEvaluation(sessionId: string) {
    const saved = await this.evaluationTask(sessionId);
    if (
      !saved ||
      saved.settled === true ||
      (!saved.active && saved.settled !== false)
    )
      return;
    let trace: Awaited<ReturnType<typeof readTraceReplay>>;
    try {
      trace = await readTraceReplay(this.home, sessionId, (s) => s);
    } catch {
      if (saved.settled === undefined)
        await this.recordEvaluationTask(
          sessionId,
          saved.id,
          saved.active,
          false,
        );
      this.index.warnings.push(
        `${sessionId}: ${RECOVERY_NOTICE} トレースを読み取れませんでした。`,
      );
      return;
    }
    const roots = trace?.records.filter(
      (r) =>
        r.kind === "task" &&
        r.phase === "start" &&
        r.input &&
        typeof r.input === "object" &&
        "taskId" in r.input &&
        r.input.taskId === saved.id,
    );
    const last = roots?.at(-1);
    const end =
      last &&
      trace?.records.findLast((r) => r.phase === "end" && r.id === last.id);
    const output =
      end?.output && typeof end.output === "object"
        ? (end.output as Record<string, unknown>)
        : {};
    const complete =
      ["workflow_complete", "reported_done"].includes(
        String(output.stopCause),
      ) ||
      (output.stopCause === "end_turn" &&
        [undefined, "off", "complete"].includes(
          output.workflowPhase as string | undefined,
        ));
    if (saved.settled === false || (last && !end)) {
      if (saved.active && complete)
        await this.recordEvaluationTask(sessionId, saved.id, false, false);
      else if (saved.settled === undefined)
        await this.recordEvaluationTask(
          sessionId,
          saved.id,
          saved.active,
          false,
        );
      this.index.warnings.push(`${sessionId}: ${RECOVERY_NOTICE}`);
    }
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
    return this.write(session.id, async () => {
      if (this.deleted.has(session.id)) return;
      const i = this.sessions.findIndex((s) => s.id === session.id);
      if (i >= 0) this.sessions[i] = session;
      else this.sessions.push(session);
      await this.index.write(this.sessions);
    });
  }
  /** 履歴は追記のみ(§12)。redact は呼び出し側が渡す。 */
  async append(
    id: string,
    messages: Message[],
    redactText: (s: string) => string,
  ) {
    if (!messages.length) return;
    return this.write(id, async () => {
      if (this.deleted.has(id)) return;
      await mkdir(join(this.home, "sessions"), { recursive: true });
      const block = (
        b: import("../core/types.js").ContentBlock,
      ): import("../core/types.js").ContentBlock => {
        if (b.type === "reasoning" || b.type === "image") return b;
        if (b.type === "tool_result" && Array.isArray(b.content))
          return { ...b, content: b.content.map(block) };
        return JSON.parse(
          redactText(JSON.stringify(b)),
        ) as import("../core/types.js").ContentBlock;
      };
      const lines = messages.map((m) =>
        JSON.stringify({
          ...m,
          // reasoningと画像本体は不透明。入れ子の画像もバイト列を保持する。
          content: m.content.map(block),
        }),
      );
      await appendDurableLog(this.history(id), lines.join("\n"));
    });
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
  /** Bounded, live lookup for history tools. Never follow a history/home alias. */
  async ownsHome(expectedHome: string): Promise<boolean> {
    try {
      const actual = await realpath(this.home);
      return process.platform === "win32"
        ? actual.toLowerCase() === expectedHome.toLowerCase()
        : actual === expectedHome;
    } catch {
      return false;
    }
  }
  async historyRecords(id: string, expectedHome: string) {
    if (!this.get(id)) return undefined;
    const same = (a: string, b: string) =>
      process.platform === "win32"
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    try {
      const home = await realpath(this.home);
      if (!same(home, expectedHome)) return undefined;
      const directory = join(home, "sessions");
      if (!same(await realpath(directory), directory)) return undefined;
      const path = join(directory, `${id}.jsonl`);
      if (!same(await realpath(this.history(id)), path)) return undefined;
      const file = await open(path, "r");
      try {
        const before = await file.stat();
        // Skip rather than returning pre-rewind text from an incomplete scan.
        if (!before.isFile() || before.size > 1024 * 1024)
          return { records: [], truncated: true };
        const bytes = Buffer.alloc(before.size);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        const after = await stat(path);
        if (
          bytesRead !== before.size ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ino !== after.ino ||
          !same(await realpath(path), path) ||
          !same(await realpath(this.home), expectedHome) ||
          !same(await realpath(directory), directory) ||
          !this.get(id)
        )
          return undefined;
        const records: { line: number; message: Message }[] = [];
        for (const [index, line] of bytes
          .toString("utf8")
          .split("\n")
          .entries()) {
          try {
            const message = JSON.parse(line) as Message;
            if (!message || !Array.isArray(message.content)) continue;
            const keep = message.meta?.rewind?.keep;
            if (keep !== undefined) {
              if (
                !Number.isSafeInteger(keep) ||
                keep < 0 ||
                keep > records.length
              )
                return undefined; // Fail closed on an ambiguous rewind.
              records.splice(keep);
            }
            records.push({ line: index + 1, message });
          } catch {
            /* Old/torn JSONL lines are not searchable. */
          }
        }
        return this.get(id) ? { records, truncated: false } : undefined;
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  }
  async evaluationTask(id: string): Promise<
    | {
        id: string;
        active: boolean;
        settled?: boolean;
        recoveryRequired?: boolean;
      }
    | undefined
  > {
    let raw: string;
    try {
      raw = await readFile(
        this.history(id).replace(/\.jsonl$/, ".evaluation.jsonl"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let latest:
      | {
          id: string;
          active: boolean;
          settled?: boolean;
          recoveryRequired?: boolean;
        }
      | undefined;
    for (const line of raw.split("\n")) {
      try {
        const value = JSON.parse(line)?.evaluationTask;
        if (
          value &&
          typeof value.id === "string" &&
          /^[\w-]{1,512}$/.test(value.id) &&
          typeof value.active === "boolean"
        )
          latest = {
            id: value.id,
            active: value.active,
            ...(typeof value.settled === "boolean"
              ? { settled: value.settled, recoveryRequired: !value.settled }
              : {}),
          };
      } catch {
        /* A partial final journal line must not hide earlier lifecycle records. */
      }
    }
    return latest;
  }
  async recordEvaluationTask(
    sessionId: string,
    id: string,
    active: boolean,
    settled?: boolean,
  ) {
    if (!/^[\w-]{1,512}$/.test(id))
      throw new Error("Invalid evaluation task id");
    await this.write(sessionId, async () => {
      if (this.deleted.has(sessionId)) return;
      await mkdir(join(this.home, "sessions"), { recursive: true });
      await appendDurableLog(
        this.history(sessionId).replace(/\.jsonl$/, ".evaluation.jsonl"),
        "\n" +
          JSON.stringify({
            evaluationTask: { id, active, settled },
            at: new Date().toISOString(),
          }) +
          "\n",
      );
    });
  }
  async delete(id: string) {
    // Fence stale turns/saves and remove from lookup BEFORE any await.
    this.deleted.add(id);
    this.sessions = this.sessions.filter((session) => session.id !== id);
    return this.write(id, async () => {
      await new FileCheckpointStore(this.home).remove(id);
      await rm(this.history(id), { force: true });
      await rm(this.history(id).replace(/\.jsonl$/, ".evaluation.jsonl"), {
        force: true,
      });
      await rm(this.history(id).replace(/\.jsonl$/, ".llm-calls.json"), {
        force: true,
      });
      await this.index.write(this.sessions);
    });
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
