import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { refreshCooldown } from "./refresh-cooldown.js";

it("retains only the attempt timestamp and enforces cooldown after restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-refresh-cooldown-"));
  try {
    expect(await refreshCooldown(home)("claude", 1000)).toBe(true);
    expect(await readFile(join(home, "auth-refresh-claude.json"), "utf8")).toBe(
      "1000",
    );
    expect(await refreshCooldown(home)("claude", 2000)).toBe(false);
    expect(await refreshCooldown(home)("codex", 2000)).toBe(true);
    expect(await refreshCooldown(home)("claude", 601000)).toBe(true);
    await writeFile(join(home, "auth-refresh-claude.json"), "broken");
    expect(await refreshCooldown(home)("claude", 9999999)).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
