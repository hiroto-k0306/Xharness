import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { resolveCli } from "./environment.js";
import { shellSearchTools } from "./shell-search.js";
import { vi } from "vitest";

it.skipIf(process.platform !== "win32")(
  "finds a fixed PowerShell location with an outdated PATH",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "xh-shell-location-"));
    try {
      const folder = join(root, "PowerShell", "7");
      await mkdir(folder, { recursive: true });
      const exe = join(folder, "pwsh.exe");
      await writeFile(exe, "dummy executable, never run");
      expect(await resolveCli("pwsh", { PATH: root, ProgramFiles: root })).toBe(
        exe,
      );
      expect(
        await resolveCli("rg", { PATH: root, ProgramFiles: root }),
      ).toBeUndefined();
      await rm(exe);
      await mkdir(exe);
      expect(
        await resolveCli("pwsh", { PATH: root, ProgramFiles: root }),
      ).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

const storeShell =
  process.platform === "win32" && process.env.LOCALAPPDATA
    ? await resolveCli("pwsh", { LOCALAPPDATA: process.env.LOCALAPPDATA })
    : undefined;
it.skipIf(!storeShell)(
  "detects and runs the installed WindowsApps alias without PATH",
  async () => {
    vi.stubEnv("PATH", "");
    try {
      expect(await resolveCli("pwsh")).toBe(storeShell);
      const result = await shellSearchTools(tmpdir())
        .get("Bash")!
        .execute(
          { command: "Write-Output 'xh-offline-shell-ok'" },
          new AbortController().signal,
        );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("xh-offline-shell-ok");
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
