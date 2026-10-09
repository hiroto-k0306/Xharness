import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Main-process only: values are used to scrub tool/model output, never persisted.
export async function readLocalSecrets(): Promise<string[]> {
  const secrets: string[] = [];
  const collect = (value: unknown, key = "") => {
    if (typeof value === "string" && /token|account.?id|api.?key/i.test(key))
      secrets.push(value);
    if (Array.isArray(value)) value.forEach((v) => collect(v));
    else if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) collect(v, k);
  };
  for (const path of [
    join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      ".credentials.json",
    ),
    join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"),
  ]) {
    try {
      collect(JSON.parse(await readFile(path, "utf8")));
    } catch {
      /* Missing credentials do not disable local tools. */
    }
  }
  return secrets;
}
