import { appendFile, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";

export const TRACE_WARNING =
  "実行トレースを保存できませんでした。会話は継続しますが、一部の経過は未記録です。";
export interface TraceStorageOptions {
  onWarning?(message: string): void;
  /** Small limits are useful for offline rotation tests. */
  maxFileBytes?: number;
  maxFileRecords?: number;
}

export async function traceFiles(home: string, id: string) {
  if (!/^[\w-]{1,512}$/.test(id)) throw new Error("Invalid trace session id");
  let names: string[];
  try {
    names = await readdir(join(home, "traces"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter(
      (name) =>
        name === `${id}.jsonl` ||
        (name.startsWith(`${id}.`) &&
          /^\d{6}\.jsonl$/.test(name.slice(id.length + 1))),
    )
    .sort((a, b) =>
      a === `${id}.jsonl` ? -1 : b === `${id}.jsonl` ? 1 : a.localeCompare(b),
    )
    .map((name) => join(home, "traces", name));
}

/** Tail reads also recover a large legacy file without loading its whole history. */
async function tail(path: string) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const buffer = Buffer.alloc(Math.min(size, 8_000_008));
    await file.read(buffer, 0, buffer.length, size - buffer.length);
    const text = buffer.toString("utf8");
    let sequence = 0;
    for (const line of text.split("\n")) {
      try {
        const value = JSON.parse(line) as { sequence?: unknown };
        if (
          typeof value.sequence === "number" &&
          Number.isSafeInteger(value.sequence)
        )
          sequence = Math.max(sequence, value.sequence);
      } catch {
        /* incomplete line after interruption */
      }
    }
    return { size, sequence, needsNewline: size > 0 && !text.endsWith("\n") };
  } finally {
    await file.close();
  }
}

/** Persistence is optional. Never replace the turn's result/error with an I/O error. */
export async function createTraceStorage(
  home: string,
  id: string,
  options: TraceStorageOptions = {},
) {
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    try {
      options.onWarning?.(TRACE_WARNING);
    } catch {
      /* observer is optional */
    }
  };
  let disabled = false;
  let sequence = 0;
  let path = join(home, "traces", `${id}.jsonl`);
  let part = 0;
  let size = 0;
  let count = 0;
  let needsNewline = false;
  const maxBytes = options.maxFileBytes ?? 8_000_000;
  const maxRecords = options.maxFileRecords ?? 5000;
  let pending = Promise.resolve();
  try {
    const files = await traceFiles(home, id);
    await mkdir(join(home, "traces"), { recursive: true });
    const last = files.at(-1);
    if (last) {
      const saved = await tail(last);
      path = last;
      part = Number(/\.(\d{6})\.jsonl$/.exec(last)?.[1] ?? 0);
      size = saved.size;
      sequence = saved.sequence;
      needsNewline = saved.needsNewline;
      // Rotate at each resumed turn: no full file scan is needed for its row count.
      count = maxRecords;
      if (!sequence) {
        for (const previous of files.slice(0, -1).reverse()) {
          sequence = (await tail(previous)).sequence;
          if (sequence) break;
        }
      }
    }
  } catch {
    disabled = true;
    warn();
  }
  return {
    sequence,
    warn,
    write(line: string) {
      pending = pending.then(async () => {
        if (disabled) return;
        try {
          const bytes = Buffer.byteLength(line + "\n");
          if (size && (size + bytes > maxBytes || count >= maxRecords)) {
            if (++part > 999999) throw new Error("Trace part limit");
            path = join(
              home,
              "traces",
              `${id}.${String(part).padStart(6, "0")}.jsonl`,
            );
            // Reserve the new name. Never overwrite an existing segment.
            const file = await open(path, "wx");
            await file.close();
            size = 0;
            count = 0;
            needsNewline = false;
          }
          await appendFile(
            path,
            (needsNewline ? "\n" : "") + line + "\n",
            "utf8",
          );
          size += bytes;
          count++;
          needsNewline = false;
        } catch {
          disabled = true;
          warn();
        }
      });
    },
    async flush() {
      await pending;
    },
  };
}
