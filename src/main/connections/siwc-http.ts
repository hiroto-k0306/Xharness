import { BoundaryError } from "./contracts.js";
import type { SiwcBinding } from "./openai.js";
import { tokenMeasurement } from "../providers/token-usage.js";
import type { SiwcGrant } from "./siwc-auth.js";

import {
  boundedJson,
  abortable,
  SIWC_ISSUER,
  SIWC_RESOURCE,
  type Http,
} from "./siwc-http-utils.js";
export {
  boundedJson,
  abortable,
  SIWC_ISSUER,
  SIWC_RESOURCE,
  type Http,
} from "./siwc-http-utils.js";
export function usableGrant(grant: SiwcGrant, now = Date.now()) {
  return (
    grant.issuer === SIWC_ISSUER &&
    grant.clientId !== "dynamic_agent_client" &&
    !!grant.clientId &&
    !!grant.subject &&
    !!grant.accessToken &&
    grant.expiresAt > now &&
    ["resource.invoke", "chatgpt.tokens.use.direct"].every((s) =>
      grant.scopes.includes(s),
    )
  );
}
const quotaCodes = [
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_usage_unavailable",
];
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
function safeEvent(value: unknown, grant: SiwcGrant) {
  const e = obj(value);
  if (typeof e.type !== "string") throw new BoundaryError("malformed");
  if (e.type === "response.output_text.delta") {
    if (typeof e.delta !== "string") throw new BoundaryError("malformed");
    let delta = e.delta;
    for (const secret of [
      grant.accessToken,
      grant.refreshToken,
      grant.idToken,
      grant.subject,
      grant.clientId,
      grant.hostId,
    ])
      if (secret) delta = delta.split(secret).join("[redacted]");
    return { type: e.type, delta };
  }
  if (
    [
      "response.completed",
      "response.failed",
      "response.incomplete",
      "error",
    ].includes(e.type)
  ) {
    const r = obj(e.response);
    const code = obj(r.error ?? e.error).code;
    const error = {
      code: quotaCodes.includes(String(code)) ? code : "transport",
    };
    return {
      type: e.type,
      error,
      response: {
        status: ["completed", "failed", "incomplete"].includes(String(r.status))
          ? r.status
          : undefined,
        error,
        usage: tokenMeasurement("codex", r.usage).raw,
      },
    };
  }
  return undefined;
}
/** Actual public Responses transport; no API-key/CLI credentials or redirects/fallback. */
export function siwcHttpBinding(
  grant: SiwcGrant,
  http: Http = fetch,
): SiwcBinding {
  grant = structuredClone(grant);
  return {
    registrationConfirmed: usableGrant(grant),
    grantSource: "registered-client",
    async *send(request, signal) {
      if (
        !usableGrant(grant) ||
        request.endpoint !== `${SIWC_RESOURCE}/responses` ||
        request.body.store !== false ||
        request.body.stream !== true
      )
        throw new BoundaryError("unconfigured");
      const inner = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const abort = () => {
        void reader?.cancel().catch(() => {});
      };
      inner.addEventListener("abort", abort, { once: true });
      try {
        inner.throwIfAborted();
        const response = await abortable(
          http(request.endpoint, {
            method: "POST",
            signal: inner,
            redirect: "error",
            headers: {
              Authorization: `Bearer ${grant.accessToken}`,
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(request.body),
          }),
          inner,
        );
        if (!response.ok) {
          if ([401, 403, 429].includes(response.status)) {
            // Preserve only documented quota codes; discard all raw messages/headers.
            const error = obj(
              (await boundedJson(responseBodyAsOk(response), inner)).error,
            );
            yield {
              type: "error",
              error: {
                code: quotaCodes.includes(String(error.code))
                  ? error.code
                  : "transport",
              },
            };
            return;
          }
          await response.body?.cancel().catch(() => {});
          throw new BoundaryError("transport");
        }
        if (
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/event-stream")
        ) {
          await response.body?.cancel().catch(() => {});
          throw new BoundaryError("malformed");
        }
        reader = response.body?.getReader();
        if (!reader) throw new BoundaryError("transport");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const secrets = [
          grant.accessToken,
          grant.refreshToken,
          grant.idToken,
          grant.subject,
          grant.clientId,
          grant.hostId,
        ].filter((s): s is string => !!s);
        const withheld = Math.max(...secrets.map((s) => s.length), 1) - 1;
        let pending = "";
        let buffer = "",
          data: string[] = [],
          size = 0,
          total = 0;
        while (true) {
          inner.throwIfAborted();
          const chunk = await reader.read();
          inner.throwIfAborted();
          if (chunk.done) return; // Inference layer rejects EOF without a terminal event.
          if ((total += chunk.value.byteLength) > 32_000_000)
            throw new BoundaryError("malformed");
          buffer += decoder.decode(chunk.value, { stream: true });
          if (buffer.length > 1_048_576) throw new BoundaryError("malformed");
          let match: RegExpExecArray | null;
          while ((match = /\r\n|\n|\r(?!$)/.exec(buffer))) {
            const line = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (!line) {
              if (data.length) {
                const raw = JSON.parse(data.join("\n"));
                const event = safeEvent(raw, grant);
                data = [];
                size = 0;
                if (event) {
                  if ("delta" in event) {
                    pending += event.delta;
                    // Hold enough tail to redact a credential split across SSE deltas.
                    for (const secret of secrets)
                      pending = pending.split(secret).join("[redacted]");
                    const ready = Math.max(0, pending.length - withheld);
                    if (ready)
                      yield {
                        type: event.type,
                        delta: pending.slice(0, ready),
                      };
                    pending = pending.slice(ready);
                  } else {
                    if (pending)
                      yield {
                        type: "response.output_text.delta",
                        delta: pending,
                      };
                    yield event;
                    return;
                  }
                }
              }
            } else if (line.startsWith("data:")) {
              if ((size += line.length) > 1_048_576)
                throw new BoundaryError("malformed");
              data.push(line.slice(5).replace(/^ /, ""));
            }
          }
        }
      } catch (error) {
        if (inner.aborted)
          throw new BoundaryError(signal.aborted ? "cancelled" : "timeout");
        if (error instanceof BoundaryError) throw error;
        throw new BoundaryError(inner.aborted ? "cancelled" : "transport");
      } finally {
        inner.removeEventListener("abort", abort);
        await reader?.cancel().catch(() => {});
        reader?.releaseLock();
      }
    },
  };
}
function responseBodyAsOk(response: Response) {
  return new Response(response.body, { status: 200 });
}
/** Account-specific catalog, same grant as inference; construction performs no request. */
export async function listSiwcModels(
  grant: SiwcGrant,
  signal: AbortSignal,
  http: Http = fetch,
) {
  if (!usableGrant(grant)) throw new BoundaryError("unconfigured");
  const inner = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await abortable(
      http(`${SIWC_RESOURCE}/models`, {
        signal: inner,
        redirect: "error",
        headers: { Authorization: `Bearer ${grant.accessToken}` },
      }),
      inner,
    );
    const body = obj(await boundedJson(response, inner));
    if (!Array.isArray(body.models)) throw new BoundaryError("malformed");
    return body.models.slice(0, 1000).flatMap((v) => {
      const m = obj(v);
      return m.visibility === "list" &&
        typeof m.slug === "string" &&
        typeof m.display_name === "string"
        ? [{ slug: m.slug, displayName: m.display_name }]
        : [];
    });
  } catch {
    throw new BoundaryError(inner.aborted ? "cancelled" : "transport");
  }
}
