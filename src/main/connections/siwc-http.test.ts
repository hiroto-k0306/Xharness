import { expect, it, vi } from "vitest";
import { siwcHttpBinding, listSiwcModels, SIWC_RESOURCE } from "./siwc-http.js";
import { SiwcInference } from "./openai.js";
import type { SiwcGrant } from "./siwc-auth.js";
import type { Input } from "./contracts.js";
const grant: SiwcGrant = {
  issuer: "https://auth.openai.com",
  clientId: "oaiapp_dummy",
  subject: "dummy-subject",
  hostId: "dummy-host",
  idToken: "dummy-id-token",
  accessToken: "dummy-access-token",
  scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
  savedAt: Date.now(),
  expiresAt: Date.now() + 3600000,
};
const input: Input = {
  taskId: "task",
  sessionId: "session",
  requestId: "request",
  model: "dummy-model",
  instructions: "fixed mock test",
  history: [{ role: "user", content: "fixed" }],
  tools: [],
  timeoutMs: 1000,
};
const done = {
  type: "response.completed",
  response: {
    status: "completed",
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 10 },
      untrusted: "dummy-access-token",
    },
  },
};
function sse(events: unknown[], unfinished = "") {
  const body =
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join("") +
    unfinished;
  const bytes = new TextEncoder().encode(body);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7)
          c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
it("streams UTF8/chunked SSE, preserves native usage and uses only public OAuth transport", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    sse([{ type: "response.output_text.delta", delta: "こんにちは" }, done]),
  );
  const result = await new SiwcInference(siwcHttpBinding(grant, http)).infer(
    input,
    new AbortController().signal,
  );
  expect(result.status).toBe("completed");
  expect(result.proposal?.answer).toBe("こんにちは");
  expect(result.measurement).toMatchObject({
    input: 100,
    output: 20,
    raw: { input_tokens: 100, output_tokens: 20 },
  });
  expect(JSON.stringify(result.measurement)).not.toContain("untrusted");
  const [endpoint, request] = http.mock.calls[0]!;
  expect(endpoint).toBe(`${SIWC_RESOURCE}/responses`);
  expect(request!.redirect).toBe("error");
  expect(request!.headers).toEqual({
    Authorization: "Bearer dummy-access-token",
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  });
  expect(JSON.parse(request!.body as string)).toMatchObject({
    store: false,
    stream: true,
    model: "dummy-model",
  });
  expect(http).toHaveBeenCalledTimes(1);
});
it.each(["eof", "malformed", "incomplete", "http", "wrong-type"])(
  "fails closed on %s without retries/raw errors",
  async (kind) => {
    const http = vi.fn<typeof fetch>(async () =>
      kind === "http"
        ? new Response("dummy-access-token", { status: 500 })
        : kind === "wrong-type"
          ? new Response("dummy", {
              headers: { "content-type": "application/json" },
            })
          : kind === "malformed"
            ? sse([], "data: not-json\n\n")
            : kind === "incomplete"
              ? sse([
                  {
                    type: "response.incomplete",
                    response: { status: "incomplete" },
                  },
                ])
              : sse(
                  [{ type: "response.output_text.delta", delta: "partial" }],
                  `data: ${JSON.stringify(done)}`,
                ),
    );
    const result = await new SiwcInference(siwcHttpBinding(grant, http)).infer(
      input,
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    expect(result.proposal).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("dummy-access-token");
    expect(http).toHaveBeenCalledTimes(1);
  },
);
it("sanitizes server errors, records documented quota and excludes secrets from returned stream", async () => {
  const http = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "subscription_sharing_usage_limit_exceeded",
            message: "dummy-access-token",
          },
        }),
        { status: 429 },
      ),
  );
  const result = await new SiwcInference(siwcHttpBinding(grant, http)).infer(
    input,
    new AbortController().signal,
  );
  expect(result.status).toBe("quota-paused");
  expect(JSON.stringify(result)).not.toContain("dummy-access-token");
  const safe = vi.fn<typeof fetch>(async () =>
    sse([
      {
        type: "response.output_text.delta",
        delta: "dummy-access-token dummy-subject",
      },
      done,
    ]),
  );
  const redacted = await new SiwcInference(siwcHttpBinding(grant, safe)).infer(
    input,
    new AbortController().signal,
  );
  expect(redacted.proposal?.answer).toBe("[redacted] [redacted]");
});
it("cancels pending stream reads and never exposes partial completion", async () => {
  const cancel = vi.fn();
  const http = vi.fn<typeof fetch>(
    async () =>
      new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const abort = new AbortController();
  const work = new SiwcInference(siwcHttpBinding(grant, http)).infer(
    input,
    abort.signal,
  );
  await new Promise((r) => setTimeout(r, 5));
  abort.abort();
  expect((await work).status).toBe("cancelled");
  expect(cancel).toHaveBeenCalled();
});
it("redacts credentials split across separate SSE deltas before exposing them", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    sse([
      { type: "response.output_text.delta", delta: "prefix dummy-access-" },
      { type: "response.output_text.delta", delta: "token suffix" },
      done,
    ]),
  );
  const result = await new SiwcInference(siwcHttpBinding(grant, http)).infer(
    input,
    new AbortController().signal,
  );
  expect(result.proposal?.answer).toBe("prefix [redacted] suffix");
});
it("retains incomplete native usage as measured partial data", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    sse([
      {
        type: "response.incomplete",
        response: { status: "incomplete", usage: { input_tokens: 7 } },
      },
    ]),
  );
  const result = await new SiwcInference(siwcHttpBinding(grant, http)).infer(
    input,
    new AbortController().signal,
  );
  expect(result.status).toBe("failed");
  expect(result.measurement).toMatchObject({ input: 7, output: null });
});
it("refuses expired/missing plan grants before dispatch and lists models with the same grant", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({
      models: [
        { visibility: "list", slug: "available", display_name: "Available" },
        { visibility: "hidden", slug: "hidden", display_name: "Hidden" },
      ],
    }),
  );
  for (const g of [
    { ...grant, expiresAt: 0 },
    { ...grant, scopes: [] },
    { ...grant, clientId: "dynamic_agent_client" },
  ])
    expect(
      (
        await new SiwcInference(siwcHttpBinding(g, http)).infer(
          input,
          new AbortController().signal,
        )
      ).error,
    ).toBe("unconfigured");
  expect(http).not.toHaveBeenCalled();
  expect(
    await listSiwcModels(grant, new AbortController().signal, http),
  ).toEqual([{ slug: "available", displayName: "Available" }]);
  expect(http.mock.calls[0]![0]).toBe(`${SIWC_RESOURCE}/models`);
});
