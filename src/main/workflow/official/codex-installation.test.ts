import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverCodexInstallation,
  resolveCodexOverride,
} from "./codex-installation.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(version = "26.1002.7124.0") {
  const root = await mkdtemp(join(tmpdir(), "codex-installation-"));
  roots.push(root);
  const bin = join(root, "app/resources");
  await mkdir(bin, { recursive: true });
  for (const name of [
    "codex.exe",
    "codex-code-mode-host.exe",
    "codex-command-runner.exe",
    "codex-windows-sandbox-setup.exe",
    "codex-windows-sandbox-service.exe",
  ])
    await writeFile(join(bin, name), "dummy, never executed");
  return {
    root,
    bin,
    metadata: {
      Name: "OpenAI.Codex",
      PublisherId: "2p2nqsd0c76g0",
      InstallLocation: root,
      PackageFullName: `OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`,
    },
  };
}
it("uses only the registered installation and follows new registration on the next lookup", async () => {
  const old = await fixture(),
    next = await fixture("26.1003.1.0");
  expect(await discoverCodexInstallation(async () => old.metadata)).toEqual({
    path: join(old.bin, "codex.exe"),
    package: old.metadata.PackageFullName,
  });
  expect(
    (await discoverCodexInstallation(async () => [next.metadata])).path,
  ).toBe(join(next.bin, "codex.exe"));
});
it.each(["ambiguous", "publisher", "missing-helper", "denied"])(
  "fails closed for %s without returning shell output",
  async (reason) => {
    const found = await fixture();
    if (reason === "missing-helper")
      await rm(join(found.bin, "codex-command-runner.exe"));
    await expect(
      discoverCodexInstallation(async () => {
        if (reason === "denied") throw new Error("secret shell output");
        if (reason === "ambiguous") return [found.metadata, found.metadata];
        if (reason === "publisher")
          return { ...found.metadata, PublisherId: "unknown" };
        return found.metadata;
      }),
    ).rejects.toThrow("公式Codexの同梱CLIを登録情報から確認できません");
  },
);
it("resolves an explicitly selected folder or exe without executing it", async () => {
  const found = await fixture();
  const exe = join(found.bin, "codex.exe");
  expect(await resolveCodexOverride(found.bin)).toBe(exe);
  expect(await resolveCodexOverride(exe)).toBe(exe);
  await rm(exe);
  await expect(resolveCodexOverride(found.bin)).rejects.toThrow(
    "自動設定へは切り替えていません",
  );
  await expect(resolveCodexOverride("codex.exe")).rejects.toThrow("絶対パス");
});
