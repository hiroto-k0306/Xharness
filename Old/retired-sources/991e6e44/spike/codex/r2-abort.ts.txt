import { loadCodexAuth } from "../lib/oauth.js";
import { probeAbort } from "../lib/abort.js";
import { codexHeaders, codexResponsesUrl } from "./request.js";

try {
  const auth = await loadCodexAuth();
  const result = await probeAbort({
    provider: "codex",
    url: codexResponsesUrl,
    headers: codexHeaders(auth),
    body: {
      model: "gpt-6-luna",
      instructions: "You are a helpful assistant.",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Reply with the single word: pong" },
          ],
        },
      ],
      tools: [],
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
    },
    secrets: [auth.accessToken, auth.accountId],
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.requestedAbort || result.exceptionName !== "AbortError")
    process.exitCode = 1;
} catch {
  console.error("Codex abort probe failed; inspect masked local recordings");
  process.exitCode = 1;
}
