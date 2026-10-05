import { mkdtemp, writeFile, rm, link, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { readImprovementFile } from "./improvement-file.js";
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), "xh-improvement-file-"));
  folders.push(folder);
  return { folder, path: join(folder, "improvements.json") };
}
it("reads only a bounded ordinary single-link UTF-8 file", async () => {
  const f = await fixture();
  expect(await readImprovementFile(f.path)).toBeUndefined();
  await writeFile(f.path, '{"version":1}');
  expect(await readImprovementFile(f.path)).toBe('{"version":1}');
  await writeFile(f.path, Buffer.from([0xff]));
  await expect(readImprovementFile(f.path)).rejects.toThrow();
  await writeFile(f.path, "a".repeat(1048577));
  await expect(readImprovementFile(f.path)).rejects.toThrow("サイズ");
});
it("refuses hard links and directory junctions without reading their target", async () => {
  const f = await fixture();
  const source = join(f.folder, "source");
  await writeFile(source, "private data");
  await link(source, f.path);
  await expect(readImprovementFile(f.path)).rejects.toThrow("境界");
  const outside = join(f.folder, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "improvements.json"), "private data");
  const alias = join(f.folder, "alias");
  await symlink(
    outside,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    readImprovementFile(join(alias, "improvements.json")),
  ).rejects.toThrow("境界");
});
