import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexCredentials {
  accessToken: string;
  accountId: string;
}
export async function readCodexCredentials(): Promise<CodexCredentials> {
  try {
    const path = join(
      process.env.CODEX_HOME || join(homedir(), ".codex"),
      "auth.json",
    );
    const value = JSON.parse(await readFile(path, "utf8")) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const auth = value.tokens;
    if (
      typeof auth?.access_token !== "string" ||
      !auth.access_token ||
      typeof auth.account_id !== "string" ||
      !auth.account_id
    )
      throw new Error();
    return { accessToken: auth.access_token, accountId: auth.account_id };
  } catch {
    throw new Error(
      "Codex credential unavailable; update it using the official CLI",
    );
  }
}
