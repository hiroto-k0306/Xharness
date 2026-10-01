import { loadClaudeAuth } from "../lib/oauth.js";
import { probeAbort } from "../lib/abort.js";

try {
  const accessToken = await loadClaudeAuth();
  const result = await probeAbort({
    provider: "claude",
    url: "https://api.anthropic.com/v1/messages",
    headers: new Headers({
      authorization: `Bearer ${accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
      accept: "text/event-stream",
    }),
    body: {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
    },
    secrets: [accessToken],
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.requestedAbort || result.exceptionName !== "AbortError")
    process.exitCode = 1;
} catch {
  console.error("Claude abort probe failed; inspect masked local recordings");
  process.exitCode = 1;
}
