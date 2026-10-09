import { readFile } from "node:fs/promises";
import { credentialPath } from "../lib/credentials.js";
import { probeText, type SystemMode, type TextModel } from "./text.js";

async function main() {
  const mode = process.argv[2] ?? "none";
  const model = process.argv[3] ?? "claude-haiku-4-5-20251001";
  if (
    !["none", "identity", "custom"].includes(mode) ||
    !["claude-haiku-4-5-20251001", "claude-opus-5-5"].includes(model)
  ) {
    console.error("Usage: spike:claude:text [none|identity|custom] [model]");
    process.exitCode = 1;
    return;
  }
  let accessToken: string;
  try {
    const credentials = JSON.parse(
      await readFile(credentialPath("claude"), "utf8"),
    ) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
    const oauth = credentials.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken)
      throw new Error();
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now()) {
      console.error("Claude OAuth credential expired; no request sent");
      process.exitCode = 1;
      return;
    }
    accessToken = oauth.accessToken;
  } catch {
    console.error("Claude OAuth credential unavailable; no request sent");
    process.exitCode = 1;
    return;
  }
  const result = await probeText(
    accessToken,
    model as TextModel,
    mode as SystemMode,
  );
  console.log(JSON.stringify(result.report, null, 2));
  if (!result.success) process.exitCode = 1;
}

try {
  await main();
} catch {
  console.error("Claude text probe failed; inspect masked local recordings");
  process.exitCode = 1;
}
