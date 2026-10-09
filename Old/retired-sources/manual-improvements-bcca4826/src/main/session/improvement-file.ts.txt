import { lstat, open, realpath, stat } from "node:fs/promises";
import { ImprovementFault } from "./improvement-document.js";
/** Bound the open handle and reject path replacement/links before returning ledger text. */
export async function readImprovementFile(
  path: string,
): Promise<string | undefined> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || (await realpath(path)) !== path)
      throw new ImprovementFault("改善ファイルの境界を確認してください。");
    const file = await open(path, "r");
    try {
      const before = await file.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > 1048576 ||
        before.ino !== entry.ino ||
        before.dev !== entry.dev
      )
        throw new ImprovementFault(
          "改善ファイルのサイズ・境界を確認してください。",
        );
      const bytes = Buffer.alloc(before.size),
        result = await file.read(bytes, 0, bytes.length, 0),
        after = await stat(path);
      if (
        result.bytesRead !== before.size ||
        before.ino !== after.ino ||
        before.dev !== after.dev ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        (await realpath(path)) !== path
      )
        throw new ImprovementFault(
          "改善ファイルが読取中に変更されました。再取得してください。",
        );
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      await file.close();
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
