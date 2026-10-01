import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function readClaudeAccessToken(): Promise<string> {
  try {
    const path = join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      ".credentials.json",
    );
    const value = JSON.parse(await readFile(path, "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const auth = value.claudeAiOauth;
    if (typeof auth?.accessToken !== "string" || !auth.accessToken)
      throw new Error();
    if (typeof auth.expiresAt === "number" && auth.expiresAt <= Date.now())
      throw new Error();
    return auth.accessToken;
  } catch {
    throw new Error(
      "Claude credential unavailable or expired; update it using the official CLI",
    );
  }
}
