import { readFile } from "node:fs/promises";
import { loadCodexAuth } from "../lib/oauth.js";
import { probeEncryptedReplay } from "./replay.js";
import { type SseEvent } from "../lib/sse.js";
import { maskSecrets } from "../lib/mask.js";

try {
  const saved = JSON.parse(
    await readFile("test/fixtures/codex/x4-gpt-6-luna-max.json", "utf8"),
  ) as { requestBody: { input: unknown[] }; events: SseEvent[] };
  const auth = await loadCodexAuth();
  const result = await probeEncryptedReplay(auth, saved);
  console.log(
    JSON.stringify(
      maskSecrets(result, [auth.accessToken, auth.accountId]),
      null,
      2,
    ),
  );
  if (!result.success) process.exitCode = 1;
} catch {
  console.error(
    "Encrypted replay probe failed; inspect masked local recordings",
  );
  process.exitCode = 1;
}
