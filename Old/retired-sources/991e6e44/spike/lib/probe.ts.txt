import { reserveRequest } from "./budget.js";
import { record } from "./record.js";
import { readSse, type SseEvent } from "./sse.js";

export async function sendProbe(options: {
  provider: "claude" | "codex";
  name: string;
  url: string;
  headers: Headers;
  body?: unknown;
  secrets: string[];
  root?: string;
  fetcher?: typeof fetch;
}) {
  const requestNumber = await reserveRequest(
    options.provider,
    options.name,
    options.root,
  );
  let response: Response | undefined;
  let body: unknown;
  let transportFailure = false;
  const events: SseEvent[] = [];
  try {
    response = await (options.fetcher ?? fetch)(options.url, {
      method: options.body === undefined ? "GET" : "POST",
      headers: options.headers,
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const event of readSse(response)) events.push(event);
    } else {
      body = await response.text();
      // Observed Codex SSE has no Content-Type; recognize its wire framing too.
      if (/^\s*(?:event:|data:|:)/.test(body as string)) {
        for await (const event of readSse(new Response(body as string)))
          events.push(event);
        body = undefined;
      }
    }
  } catch {
    transportFailure = true;
    body = { error: { type: "transport_error" } };
  }
  const status = response?.status ?? 0;
  const responseHeaders = response?.headers ?? new Headers();
  const paths = await record(
    options.provider,
    options.name,
    {
      requestHeaders: options.headers,
      requestBody: options.body,
      status,
      responseHeaders,
      events,
      body,
    },
    { root: options.root, secrets: options.secrets },
  );
  return {
    ok: response?.ok === true && !transportFailure,
    requestNumber,
    status,
    responseHeaders,
    events,
    body,
    paths,
    transportFailure,
  };
}
