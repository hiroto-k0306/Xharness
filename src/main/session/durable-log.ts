import { open } from "node:fs/promises";

/** Each batch starts on a fresh line even after a torn write. Never truncate evidence. */
export async function appendDurableLog(path: string, text: string) {
  const file = await open(path, "a+");
  try {
    const size = (await file.stat()).size;
    const last = Buffer.alloc(1);
    if (size) await file.read(last, 0, 1, size - 1);
    await file.writeFile(
      (size && last[0] !== 10 ? "\n" : "") +
        text +
        (text.endsWith("\n") ? "" : "\n"),
      "utf8",
    );
    await file.sync();
  } finally {
    await file.close();
  }
}
