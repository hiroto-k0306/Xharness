import { reserveRequest } from "./budget.js";
import { record } from "./record.js";
import { readSse, type SseEvent } from "./sse.js";

export async function probeAbort(options: {
  provider: "claude" | "codex";
  url: string;
  headers: Headers;
  body: unknown;
  secrets: string[];
  root?: string;
  fetcher?: typeof fetch;
}) {
  const requestNumber = await reserveRequest(
    options.provider,
    "r2-abort",
    options.root,
  );
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(30_000),
  ]);
  const events: SseEvent[] = [];
  let response: Response | undefined;
  let body: unknown;
  let exceptionName: string | undefined;
  let abortAfterEvent: string | undefined;
  try {
    response = await (options.fetcher ?? fetch)(options.url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(options.body),
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      body = await response.text();
    } else {
      // Both endpoints were observed to emit SSE; Codex can omit Content-Type.
      for await (const event of readSse(response)) {
        events.push(event);
        if (!controller.signal.aborted) {
          abortAfterEvent = event.event;
          controller.abort();
        }
      }
    }
  } catch (error) {
    // Never persist exception messages, stacks, or arbitrary names from a server.
    const name = error instanceof Error ? error.name : undefined;
    exceptionName =
      name &&
      [
        "AbortError",
        "TimeoutError",
        "TypeError",
        "Error",
        "NetworkError",
      ].includes(name)
        ? name
        : "UnknownError";
    body = {
      error: {
        type: controller.signal.aborted ? "aborted" : "transport_error",
        name: exceptionName,
      },
    };
  }
  const status = response?.status ?? 0;
  const observation = {
    requestedAbort: controller.signal.aborted,
    abortAfterEvent,
    exceptionName,
    eventCount: events.length,
  };
  const paths = await record(
    options.provider,
    "r2-abort",
    {
      requestHeaders: options.headers,
      requestBody: options.body,
      responseHeaders: response?.headers ?? new Headers(),
      status,
      events,
      body: { observation, responseBody: body },
    },
    { root: options.root, secrets: options.secrets },
  );
  return { status, requestNumber, ...observation, paths };
}
