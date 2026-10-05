import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { executeRefresh } from "./refresh-cli.js";
import { resolveCli } from "../tools/environment.js";

const shell =
  process.platform === "win32" ? await resolveCli("pwsh") : undefined;
it.skipIf(!shell)(
  "preserves Codex TOML arguments through a dummy npm cmd shim",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "xh-refresh-shim-"));
    try {
      const output = join(directory, "args.json");
      const script = join(directory, "dummy.cjs");
      const shim = join(directory, "dummy.cmd");
      vi.stubEnv("XH_REFRESH_TEST_OUT", output);
      vi.stubEnv("CODEX_HOME", join(directory, "credentials"));
      vi.stubEnv("CLAUDE_CONFIG_DIR", join(directory, "credentials"));
      await writeFile(
        script,
        'require("node:fs").writeFileSync(process.env.XH_REFRESH_TEST_OUT, JSON.stringify({args: process.argv.slice(2), cwd: process.cwd(), entries: require("node:fs").readdirSync(process.cwd())}));',
      );
      await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`);
      expect(await executeRefresh("codex", shim)).toBe("success");
      const result = JSON.parse(await readFile(output, "utf8"));
      expect(result.args).toContain('model_reasoning_effort="low"');
      expect(result.args).toContain('web_search="disabled"');
      expect(result.args).toContain('approval_policy="never"');
      expect(result.args).toContain("read-only");
      expect(result.args).toContain("--ignore-user-config");
      expect(result.entries).toEqual([]);
      await expect(stat(result.cwd)).rejects.toThrow();
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);
