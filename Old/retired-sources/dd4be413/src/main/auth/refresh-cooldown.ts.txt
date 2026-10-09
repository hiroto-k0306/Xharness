import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type ProviderName } from "../../shared/ipc.js";

/** Only attempt timestamps are persisted, never credentials or CLI output. */
export function refreshCooldown(home: string) {
  return async (provider: ProviderName, now: number): Promise<boolean> => {
    const path = join(home, `auth-refresh-${provider}.json`);
    try {
      const last: unknown = JSON.parse(await readFile(path, "utf8"));
      if (typeof last !== "number" || !Number.isFinite(last)) return false;
      if (now - last < 600000) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    await mkdir(home, { recursive: true });
    const temporary = path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify(now), { flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return true;
  };
}
