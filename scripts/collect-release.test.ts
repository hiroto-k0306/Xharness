import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectRelease, releaseFiles } from "./collect-release.js";

/** dist に偽の exe を置いた、試験用のリポジトリ */
async function fakeRepo(version = "1.2.3", withExe = true) {
  const base = await mkdtemp(join(tmpdir(), "xh-release-"));
  const root = join(base, "Xharness");
  await mkdir(join(root, "dist", "win-unpacked"), { recursive: true });
  await mkdir(join(root, "release"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(join(root, "release", "README.md"), "# XHarness\n");
  // 集めてはいけないもの(headless のビルド結果・展開版)
  await writeFile(join(root, "dist", "headless.js"), "x");
  await writeFile(join(root, "dist", "win-unpacked", "XHarness.exe"), "x");
  if (withExe) {
    const files = releaseFiles(version);
    await writeFile(join(root, "dist", files.installer), "installer");
    await writeFile(join(root, "dist", files.portable), "portable");
  }
  return { base, root };
}

describe("collect release files", () => {
  it("copies only the exes and README outside the repository, with checksums", async () => {
    const { base, root } = await fakeRepo();
    const result = await collectRelease({ root });
    expect(result.target).toBe(
      join(base, "XHarness-release", "XHarness-1.2.3"),
    );
    expect((await readdir(result.target)).sort()).toEqual([
      "README.md",
      "SHA256SUMS.txt",
      "XHarness-1.2.3-portable.exe",
      "XHarness-Setup-1.2.3.exe",
    ]);
    const sums = await readFile(join(result.target, "SHA256SUMS.txt"), "utf8");
    const hash = createHash("sha256").update("portable").digest("hex");
    expect(sums).toContain(`${hash}  XHarness-1.2.3-portable.exe`);
    expect(sums.trim().split("\n")).toHaveLength(3);
  });
  it("refuses to write inside the repository and to overwrite an archived version", async () => {
    const { root } = await fakeRepo();
    await expect(
      collectRelease({ root, out: join(root, "out-release") }),
    ).rejects.toThrow("リポジトリの中");
    await collectRelease({ root });
    await expect(collectRelease({ root })).rejects.toThrow("上書きしません");
    await expect(collectRelease({ root, force: true })).resolves.toBeDefined();
  });
  it("asks to run pnpm package when the exes are missing", async () => {
    const { root } = await fakeRepo("2.0.0", false);
    await expect(collectRelease({ root })).rejects.toThrow("pnpm package");
  });
});
