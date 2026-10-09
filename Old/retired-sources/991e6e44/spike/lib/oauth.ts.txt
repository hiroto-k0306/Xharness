import { readFile } from "node:fs/promises";
import { credentialPath } from "./credentials.js";

// These values stay in the spike process and are never printed or persisted.
export async function loadClaudeAuth() {
  try {
    const root = JSON.parse(
      await readFile(credentialPath("claude"), "utf8"),
    ) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = root.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken)
      throw new Error();
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now())
      throw new Error();
    return oauth.accessToken;
  } catch {
    throw new Error(
      "Claude OAuth credential unavailable or expired; no request sent",
    );
  }
}

export async function loadCodexAuth() {
  try {
    const root = JSON.parse(
      await readFile(credentialPath("codex"), "utf8"),
    ) as {
      tokens?: { access_token?: unknown; account_id?: unknown };
    };
    const tokens = root.tokens;
    if (
      typeof tokens?.access_token !== "string" ||
      !tokens.access_token ||
      typeof tokens.account_id !== "string" ||
      !tokens.account_id
    )
      throw new Error();
    return { accessToken: tokens.access_token, accountId: tokens.account_id };
  } catch {
    throw new Error("Codex OAuth credential unavailable; no request sent");
  }
}
