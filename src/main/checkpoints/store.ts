import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  lstat,
  rename,
  rm,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, relative, isAbsolute, resolve, dirname } from "node:path";
import { FileAccess } from "../tools/files.js";
import { isSecretPath } from "../core/sensitive-paths.js";
import { type RewindPreview, type RewindChoice } from "../../shared/rewind.js";

export const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
interface Entry {
  id: string;
  path: string;
  before: string | null;
  after: string | null;
  blob?: string;
  unavailable?: string;
}
interface Turn {
  inactive?: boolean;
  id: string;
  createdAt: number;
  cwd: string;
  messages: number;
  files: Entry[];
}
export interface RestorePlan {
  turnIds: string[];
  preview: RewindPreview;
  messages: number;
  entries: (Entry & {
    observed: string | null;
    conflict: boolean;
    directory: string;
  })[];
}
function identifier(id: string) {
  if (!/^[\w-]+$/.test(id))
    throw new Error("チェックポイント識別子が不正です。");
  return id;
}
async function fingerprint(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
async function json(path: string, value: unknown) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(value), { flag: "wx" });
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export class FileCheckpointStore {
  private static readonly purges = new Map<
    string,
    { at: number; done: Promise<void> }
  >();
  readonly root: string;
  constructor(home: string) {
    this.root = resolve(home, "checkpoints");
  }
  private directory(sessionId: string, turn?: string) {
    return join(
      this.root,
      identifier(sessionId),
      ...(turn ? [identifier(turn)] : []),
    );
  }
  private async checked(directory: string) {
    const rel = relative(this.root, directory);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("チェックポイントの保存先が不正です。");
    for (const path of [this.root, dirname(directory), directory]) {
      try {
        if ((await lstat(path)).isSymbolicLink())
          throw new Error("チェックポイントのリンクは使えません。");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  private async turns(sessionId: string): Promise<Turn[]> {
    const directory = this.directory(sessionId);
    await this.checked(directory);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const turns: Turn[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const folder = this.directory(sessionId, entry.name);
      await this.checked(folder);
      const manifest = join(folder, "turn.json");
      let value: Turn;
      try {
        if ((await lstat(manifest)).isSymbolicLink())
          throw new Error("不正な記録です。");
        value = JSON.parse(await readFile(manifest, "utf8")) as Turn;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        value.id !== entry.name ||
        !Number.isFinite(value.createdAt) ||
        !Number.isSafeInteger(value.messages) ||
        value.messages < 0 ||
        typeof value.cwd !== "string" ||
        !Array.isArray(value.files) ||
        value.files.some(
          (f) =>
            typeof f.path !== "string" ||
            !isAbsolute(f.path) ||
            typeof f.id !== "string" ||
            !/^[\w-]+$/.test(f.id) ||
            (f.blob && f.blob !== f.id + ".bin") ||
            (f.before !== null && !/^[a-f0-9]{64}$/.test(f.before)) ||
            (f.after !== null && !/^[a-f0-9]{64}$/.test(f.after)),
        )
      )
        throw new Error("チェックポイントの記録が不正です。");
      turns.push(value);
    }
    return turns.sort((a, b) => a.createdAt - b.createdAt);
  }
  async begin(
    sessionId: string,
    cwd: string,
    messages: number,
    clean: (s: string) => string,
    warn: (message: string) => void,
  ) {
    const inside = relative(resolve(cwd), this.root);
    if (!inside.startsWith("..") && !isAbsolute(inside))
      throw new Error("退避先は作業フォルダの外に置いてください。");
    if (clean(cwd) !== cwd)
      throw new Error("秘密値を含む作業フォルダは退避できません。");
    const previous = await this.turns(sessionId);
    const turn: Turn = {
      id: randomUUID(),
      createdAt: Math.max(Date.now(), (previous.at(-1)?.createdAt ?? 0) + 1),
      cwd,
      messages,
      files: [],
    };
    const directory = this.directory(sessionId, turn.id);
    await this.checked(directory);
    await mkdir(directory, { recursive: true });
    let saves = Promise.resolve();
    const save = () => {
      const job = saves.then(() => json(join(directory, "turn.json"), turn));
      saves = job.catch(() => undefined);
      return job;
    };
    await save();
    const capture = async (path: string) => {
      if (turn.files.some((f) => f.path === clean(path))) return;
      const id = randomUUID();
      let bytes: Buffer | undefined;
      let unavailable: string | undefined;
      if (
        isSecretPath(path) ||
        clean(path) !== path ||
        /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(path)
      )
        unavailable = "秘密・保護ファイルのため退避しません。";
      else
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
            unavailable = "リンクや通常ファイル以外は退避しません。";
          else if (info.size > 10 * 1024 * 1024)
            unavailable = "10 MBを超えるため退避しません。";
          else {
            bytes = await readFile(path);
            if (bytes.length > 10 * 1024 * 1024)
              unavailable = "10 MBを超えるため退避しません。";
            else if (clean(bytes.toString("utf8")) !== bytes.toString("utf8"))
              unavailable = "秘密値を含むため退避しません。";
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      const before = !unavailable && bytes ? digest(bytes) : null;
      const entry: Entry = {
        id,
        path: clean(path),
        before,
        after: before,
        ...(unavailable ? { unavailable } : bytes ? { blob: id + ".bin" } : {}),
      };
      if (entry.blob)
        await writeFile(join(directory, entry.blob), bytes!, { flag: "wx" });
      turn.files.push(entry);
      await save();
      if (unavailable)
        warn(`${clean(path)}：${unavailable} このファイルは巻き戻せません。`);
    };
    let captures = Promise.resolve();
    return {
      beforeWrite: (path: string) => {
        const job = captures.then(() => capture(path));
        captures = job.catch(() => undefined);
        return job;
      },
      afterWrite: async (path: string, bytes: Buffer) => {
        const entry = turn.files.find((f) => f.path === clean(path));
        if (entry) {
          entry.after = digest(bytes);
          await save();
        }
      },
    };
  }
  async preview(sessionId: string, count: number): Promise<RestorePlan> {
    const turns = await this.turns(sessionId);
    const active = turns.filter((turn) => !turn.inactive);
    if (!Number.isSafeInteger(count) || count < 1 || active.length < count)
      throw new Error("指定したターンのチェックポイントがありません。");
    const first = active.at(-count)!;
    const selected = turns.slice(
      turns.findIndex((turn) => turn.id === first.id),
    );
    const combined = new Map<
      string,
      Entry & { directory: string; conflict: boolean }
    >();
    for (const turn of selected)
      for (const file of turn.files) {
        const previous = combined.get(file.path);
        combined.set(
          file.path,
          previous
            ? {
                ...previous,
                after: file.after,
                conflict: previous.conflict || previous.after !== file.before,
                unavailable: previous.unavailable ?? file.unavailable,
              }
            : {
                ...file,
                directory: this.directory(sessionId, turn.id),
                conflict: false,
              },
        );
      }
    const entries: RestorePlan["entries"] = [];
    for (const entry of combined.values()) {
      let observed: string | null = null;
      try {
        const canonical = await new FileAccess(selected[0]!.cwd).path(
          entry.path,
        );
        if (canonical !== entry.path) throw new Error();
        const info = await lstat(entry.path).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (info && (!info.isFile() || info.isSymbolicLink() || info.nlink > 1))
          throw new Error();
        observed = await fingerprint(entry.path);
      } catch {
        entry.unavailable ??=
          "対象の種類・アクセス権限・リンク先が変わっています。";
      }
      entries.push({
        ...entry,
        observed,
        conflict: entry.conflict || observed !== entry.after,
      });
    }
    return {
      turnIds: selected.map((turn) => turn.id),
      messages: selected[0]!.messages,
      entries,
      preview: {
        turns: count,
        files: entries.map(({ id, path, conflict, unavailable }) => ({
          id,
          path,
          conflict,
          unavailable,
        })),
      },
    };
  }
  async restore(plan: RestorePlan, choice: RewindChoice, signal: AbortSignal) {
    const restored: string[] = [],
      skipped: string[] = [];
    if (choice.scope !== "conversation")
      for (const entry of plan.entries) {
        try {
          if (signal.aborted) {
            skipped.push(entry.path);
            continue;
          }
          if (
            entry.unavailable ||
            (entry.conflict && !choice.includeConflicts.includes(entry.id))
          ) {
            skipped.push(entry.path);
            continue;
          }
          // Do not expand consent to changes made while the approval panel was open.
          const canonical = await new FileAccess(".").path(entry.path);
          const info = await lstat(entry.path).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined;
              throw error;
            },
          );
          if (
            canonical !== entry.path ||
            (info &&
              (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)) ||
            (await fingerprint(entry.path)) !== entry.observed
          ) {
            skipped.push(entry.path);
            continue;
          }
          if (entry.before === null) await rm(entry.path, { force: true });
          else {
            if (!entry.blob) throw new Error("退避ファイルがありません。");
            await this.checked(entry.directory);
            const blob = join(entry.directory, entry.blob);
            const info = await lstat(blob);
            if (
              !info.isFile() ||
              info.isSymbolicLink() ||
              info.size > 10 * 1024 * 1024
            )
              throw new Error("退避ファイルが不正です。");
            const bytes = await readFile(blob);
            if (digest(bytes) !== entry.before)
              throw new Error("退避ファイルが変更されています。");
            await mkdir(dirname(entry.path), { recursive: true });
            const temporary =
              entry.path + ".xharness-restore-" + randomUUID() + ".tmp";
            try {
              await writeFile(temporary, bytes, { flag: "wx" });
              // Recheck after writing the temporary file, before replacement.
              if (
                signal.aborted ||
                (await new FileAccess(".").path(entry.path)) !== entry.path ||
                (await fingerprint(entry.path)) !== entry.observed
              )
                throw new Error("復元対象が変わりました。");
              await rename(temporary, entry.path);
            } finally {
              await rm(temporary, { force: true });
            }
          }
          restored.push(entry.path);
        } catch {
          skipped.push(entry.path);
        }
      }
    return { restored, skipped };
  }
  async conversationRewound(
    sessionId: string,
    plan: RestorePlan,
    restored: string[] = [],
  ) {
    const turns = await this.turns(sessionId);
    const last = new Map<string, Entry>();
    for (const turn of turns)
      if (plan.turnIds.includes(turn.id))
        for (const file of turn.files) last.set(file.path, file);
    for (const path of restored) {
      const file = last.get(path);
      const original = plan.entries.find((entry) => entry.path === path);
      if (file && original) file.after = original.before;
    }
    for (const turn of turns) {
      if (!plan.turnIds.includes(turn.id)) continue;
      turn.inactive = true;
      await json(join(this.directory(sessionId, turn.id), "turn.json"), turn);
    }
  }
  async remove(sessionId: string) {
    const directory = this.directory(sessionId);
    await this.checked(directory);
    await rm(directory, { recursive: true, force: true });
  }
  async purge(retentionDays: number, now = Date.now(), force = false) {
    const key =
      process.platform === "win32" ? this.root.toLowerCase() : this.root;
    const previous = FileCheckpointStore.purges.get(key);
    if (previous && !force && now - previous.at < 3600000) return previous.done;
    const done = (previous?.done ?? Promise.resolve()).then(() =>
      this.purgeExpired(retentionDays, now),
    );
    FileCheckpointStore.purges.set(key, { at: now, done });
    return done;
  }
  private async purgeExpired(retentionDays: number, now: number) {
    // Expiry is best effort; unrelated damaged records must never stop a turn.
    try {
      if (
        !Number.isSafeInteger(retentionDays) ||
        retentionDays < 1 ||
        (await lstat(this.root)).isSymbolicLink()
      )
        return;
      for (const session of await readdir(this.root, { withFileTypes: true })) {
        if (
          !session.isDirectory() ||
          session.isSymbolicLink() ||
          !/^[\w-]+$/.test(session.name)
        )
          continue;
        try {
          const parent = this.directory(session.name);
          await this.checked(parent);
          for (const turn of await readdir(parent, { withFileTypes: true })) {
            if (
              !turn.isDirectory() ||
              turn.isSymbolicLink() ||
              !/^[\w-]+$/.test(turn.name)
            )
              continue;
            try {
              const directory = this.directory(session.name, turn.name);
              await this.checked(directory);
              const manifest = join(directory, "turn.json");
              const info = await lstat(manifest);
              if (!info.isFile() || info.isSymbolicLink()) continue;
              const value: unknown = JSON.parse(
                await readFile(manifest, "utf8"),
              );
              const createdAt = (value as { createdAt?: unknown } | null)
                ?.createdAt;
              if (
                typeof createdAt !== "number" ||
                !Number.isFinite(createdAt) ||
                createdAt < 0 ||
                createdAt >= now - retentionDays * 86400000
              )
                continue;
              await this.checked(directory);
              await rm(directory, { recursive: true, force: true });
            } catch {
              /* Preserve unreadable or unsafe records. */
            }
          }
        } catch {
          /* Continue with other sessions. */
        }
      }
    } catch {
      /* Missing or inaccessible backup storage is not a turn failure. */
    }
  }
}
