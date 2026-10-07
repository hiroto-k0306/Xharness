/** Explicit isolated fake profile only. No provider network, SDK, or real token. */
import { randomUUID } from "node:crypto";
import { SiwcManager } from "./siwc-manager.js";
import type { SiwcVault } from "./siwc-vault.js";
import { SIWC_ISSUER } from "./siwc-http-utils.js";
import type { listenSiwcCallback } from "./siwc-callback.js";
import type { SiwcGrant } from "./siwc-auth.js";
export function fixtureSiwcManager(vault: SiwcVault) {
  let number = 0;
  const listen: typeof listenSiwcCallback = async (options) => {
    const n = ++number,
      now = Date.now();
    const grant: SiwcGrant = {
      issuer: SIWC_ISSUER,
      hostId: options.hostId,
      clientId: options.selected?.clientId ?? `oaiapp_fixture_${n}`,
      subject: options.selected?.subject ?? `fixture-subject-${n}`,
      accessToken: `fixture-access-${randomUUID()}`,
      refreshToken: `fixture-refresh-${randomUUID()}`,
      idToken: "fixture-id",
      scopes: [
        "openid",
        "offline_access",
        "resource.invoke",
        "chatgpt.tokens.use.direct",
      ],
      savedAt: now,
      expiresAt: now + 3600000,
    };
    return {
      authorizationUrl: `${SIWC_ISSUER}/api/accounts/authorize`,
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      result: Promise.resolve(grant),
      cancel() {},
      retryClientId: () => undefined,
    };
  };
  const http: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/models"))
      return Response.json({
        models: [
          { visibility: "list", slug: "gpt-5.4", display_name: "Fixture" },
        ],
      });
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        issuer: SIWC_ISSUER,
        revocation_endpoint: `${SIWC_ISSUER}/revoke`,
      });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    if (!url.endsWith("/responses")) throw new Error("Fixture unsupported");
    return new Response(
      "data: " +
        JSON.stringify({
          type: "response.output_text.delta",
          delta: JSON.stringify({ answer: "SIWC-OK", actions: [] }),
        }) +
        "\n\ndata: " +
        JSON.stringify({
          type: "response.completed",
          response: {
            status: "completed",
            usage: { input_tokens: 3, output_tokens: 2 },
          },
        }) +
        "\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  return new SiwcManager(vault, async () => {}, {
    listen,
    http,
    simulated: true,
  });
}
