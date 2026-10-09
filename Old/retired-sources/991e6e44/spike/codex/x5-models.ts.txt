import { loadCodexAuth } from "../lib/oauth.js";
import { sendProbe } from "../lib/probe.js";
import { maskSecrets } from "../lib/mask.js";
import { codexHeaders } from "./request.js";
import { readCatalog } from "./models.js";

try {
  const auth = await loadCodexAuth();
  const secrets = [auth.accessToken, auth.accountId];
  const result = await sendProbe({
    provider: "codex",
    name: "x5-models",
    secrets,
    url: "https://chatgpt.com/backend-api/codex/models?client_version=0.159.2",
    headers: codexHeaders(auth),
  });
  const models =
    result.ok && typeof result.body === "string"
      ? readCatalog(JSON.parse(result.body))
      : [];
  console.log(
    JSON.stringify(
      maskSecrets(
        {
          status: result.status,
          requestNumber: result.requestNumber,
          modelCount: models.length,
          etag: result.responseHeaders.get("etag"),
          paths: result.paths,
          models: models.map((model) => ({
            slug: model.slug,
            contextWindow: model.context_window,
            efforts: model.supported_reasoning_levels?.map(
              (level) => level.effort,
            ),
          })),
          errorBody: result.ok ? undefined : result.body,
        },
        secrets,
      ),
      null,
      2,
    ),
  );
  if (!result.ok || models.length === 0) process.exitCode = 1;
} catch {
  console.error("Codex model probe failed; inspect masked local recordings");
  process.exitCode = 1;
}
