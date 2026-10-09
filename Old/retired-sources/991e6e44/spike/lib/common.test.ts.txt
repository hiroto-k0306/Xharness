import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectHeaders } from "./headers.js";
import { mask, maskSecrets } from "./mask.js";
import { record } from "./record.js";
import { readSse } from "./sse.js";

describe("secret masking", () => {
  it("preserves numeric token counts without corrupting headers or model IDs", () => {
    const input = {
      data: JSON.stringify({
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_read_input_tokens: 0,
        },
      }),
      model: "claude-haiku-4-5-20251001",
      reset: "1790830800",
      utilization: "0.3",
      max_tokens: 64,
      access_token: "fake-access-value",
      other: { input_tokens: "fake-private-value" },
    };
    const safe = maskSecrets(input) as typeof input;
    expect(JSON.parse(safe.data)).toEqual({
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0 },
    });
    expect(safe.model).toBe(input.model);
    expect(safe.reset).toBe(input.reset);
    expect(safe.utilization).toBe(input.utilization);
    expect(safe.max_tokens).toBe(64);
    expect(JSON.stringify(safe)).not.toContain("fake-access-value");
    expect(JSON.stringify(safe)).not.toContain("fake-private-value");
  });
  it("masks nested keys, arrays, short strings and numeric account IDs without mutation", () => {
    const input = {
      nested: [
        {
          accessToken: "fake-access-value",
          account_id: 123456,
          secret: ["tiny"],
        },
      ],
      authorization: "Bearer fake-access-value",
      error: "echo fake-access-value",
      normal: true,
    };
    const output = JSON.stringify(maskSecrets(input));
    expect(output).not.toContain("fake-access-value");
    expect(output).not.toContain("123456");
    expect(output).not.toContain("tiny");
    expect(output).toContain("fake-a…");
    expect(input.nested[0]?.accessToken).toBe("fake-access-value");
    expect(mask("short")).toBe("[REDACTED]");
  });
  it("scrubs known secrets, bearer strings, API keys and JWTs in free text", () => {
    const output = maskSecrets(
      {
        text: "Bearer example-token sk-ant-example-key eyJfake.payload.signature ID=private-id",
      },
      ["private-id"],
    );
    expect(output).toEqual({
      text: "Bearer [REDACTED] [REDACTED] [REDACTED] ID=privat…",
    });
  });
});

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    }),
  );
}

describe("SSE", () => {
  it.each(["\n", "\r\n", "\r"])(
    "handles %j delimiters, UTF-8 byte splits and multiple data lines",
    async (newline) => {
      const text = [
        ": keepalive",
        "event: delta",
        "data: 日本",
        "data: 語",
        "",
        "data: [DONE]",
        "",
        "",
      ].join(newline);
      const bytes = new TextEncoder().encode(text);
      const response = responseFromChunks(
        Array.from(bytes, (byte) => Uint8Array.of(byte)),
      );
      const events = [];
      for await (const event of readSse(response)) events.push(event);
      expect(events).toEqual([
        { event: "delta", data: "日本\n語" },
        { event: "message", data: "[DONE]" },
      ]);
      expect(response.body?.locked).toBe(false);
    },
  );
  it("discards an event without a terminating blank line", async () => {
    const events = [];
    for await (const event of readSse(new Response("data: unfinished\n")))
      events.push(event);
    expect(events).toEqual([]);
  });
  it("cancels the stream when the consumer stops early", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    for await (const event of readSse(response)) {
      expect(event.data).toBe("first");
      break;
    }
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });
});

it("extracts usage headers and removes confidential headers", () => {
  expect(
    inspectHeaders(
      new Headers({
        "retry-after": "5",
        "content-type": "text/event-stream",
        "set-cookie": "private-cookie",
        "chatgpt-account-id": "private-id",
      }),
    ),
  ).toEqual({
    all: { "content-type": "text/event-stream", "retry-after": "5" },
    usage: { "retry-after": "5" },
  });
});

it("never saves credentials in either recording, including echoed errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "xharness-record-"));
  try {
    const paths = await record(
      "codex",
      "sample",
      {
        status: 401,
        requestHeaders: new Headers({
          authorization: "Bearer fake-access-value",
          "chatgpt-account-id": "private-id",
        }),
        responseHeaders: new Headers({
          "set-cookie": "private-cookie",
          "retry-after": "5",
        }),
        events: [{ data: "echo fake-access-value private-id private-cookie" }],
        body: { nested: { refresh_token: "fake-refresh-value" } },
      },
      { root },
    );
    for (const path of Object.values(paths)) {
      const saved = await readFile(path, "utf8");
      for (const secret of [
        "fake-access-value",
        "private-id",
        "private-cookie",
        "fake-refresh-value",
      ]) {
        expect(saved).not.toContain(secret);
      }
      expect(saved).not.toContain("authorization");
      expect(saved).not.toContain("chatgpt-account-id");
      expect(saved).toContain("retry-after");
    }
    await expect(
      record(
        "codex",
        "../escape",
        { status: 200, responseHeaders: new Headers(), events: [] },
        { root },
      ),
    ).rejects.toThrow("Invalid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("masks embedded SSE JSON and secrets containing regex syntax", () => {
  const input = {
    data: '{"nested":{"access_token":"fake.token+[value]","account_id":7654321}}',
    error: "echo fake.token+[value] and 7654321",
    normal: "keep this",
  };
  const safe = maskSecrets(input) as typeof input;
  expect(JSON.stringify(safe)).not.toContain("fake.token+[value]");
  expect(JSON.stringify(safe)).not.toContain("7654321");
  expect(JSON.parse(safe.data)).toEqual({
    nested: { access_token: "fake.t…", account_id: "[REDACTED]" },
  });
  expect(safe.normal).toBe("keep this");
});

it("propagates an interrupted SSE read and releases its reader", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("Interrupted", "AbortError"));
      },
    }),
  );
  await expect(
    (async () => {
      for await (const event of readSse(response)) void event;
    })(),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(response.body?.locked).toBe(false);
});
