import { describe, expect, it, vi } from "vitest";
import { BINDING_BETA, bindingFetcher, type Sent } from "./thinking-binding.js";

describe("thinking-binding check fetcher", () => {
  it("adds the binding beta and error-mode thinking without dropping existing betas", async () => {
    const sent: Sent[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 200 }));
    const reserve = vi.fn().mockResolvedValue(1);
    const wrapped = bindingFetcher(sent, () => "a-workflow", {
      fetcher,
      reserve,
    });
    await wrapped("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "anthropic-beta": "oauth-2025-04-20,compact-2026-09-04" },
      body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }),
    });
    const init = fetcher.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("anthropic-beta")).toBe(
      `oauth-2025-04-20,compact-2026-09-04,${BINDING_BETA}`,
    );
    expect(JSON.parse(String(init.body)).thinking).toEqual({
      type: "adaptive",
      block_binding: { prefix_mismatch_behavior: "error" },
    });
    expect(sent).toEqual([{ step: "a-workflow", status: 200 }]);
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  it("records only the error message of a 400, not the request", async () => {
    const sent: Sent[] = [];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "messages.1.content.0: thinking block is bound to a different conversation",
          },
        }),
        { status: 400 },
      ),
    );
    const wrapped = bindingFetcher(sent, () => "b-continue", {
      fetcher,
      reserve: async () => 1,
    });
    const response = await wrapped("u", { headers: {}, body: "{}" });
    expect(response.status).toBe(400);
    expect(sent[0]).toEqual({
      step: "b-continue",
      status: 400,
      error:
        "messages.1.content.0: thinking block is bound to a different conversation",
    });
  });
  it("sends nothing once the budget is used up", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const wrapped = bindingFetcher([], () => "a", {
      fetcher,
      reserve: async () => {
        throw new Error("Request budget for thinking-binding exhausted");
      },
    });
    await expect(wrapped("u", { body: "{}" })).rejects.toThrow("exhausted");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("records the safe status immediately, before a later compaction can fail", async () => {
    const record = vi.fn().mockResolvedValue(undefined);
    const wrapped = bindingFetcher([], () => "b-compact", {
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { message: "messages.1.content.0: prefix mismatch" },
          }),
          { status: 400 },
        ),
      ),
      reserve: async () => 1,
      record,
    });
    await wrapped("u", { body: "{}" });
    expect(record).toHaveBeenCalledWith({
      step: "b-compact",
      status: 400,
      error: "messages.1.content.0: prefix mismatch",
    });
  });
  it("refuses to run without --yes", async () => {
    const { main } = await import("./thinking-binding.js");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await main([]);
    expect(error.mock.calls[0]![0]).toContain("--yes");
    error.mockRestore();
    process.exitCode = 0;
  });
});

const sse = (events: unknown[]) =>
  new Response(
    events
      .map((e) => `event: x\r\ndata: ${JSON.stringify(e)}\r\n\r\n`)
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const start = {
  type: "message_start",
  message: {
    model: "claude-opus-5-5",
    usage: { input_tokens: 1, output_tokens: 0 },
  },
};
const stop = (reason: string) => [
  {
    type: "message_delta",
    delta: { stop_reason: reason },
    usage: { output_tokens: 1 },
  },
  { type: "message_stop" },
];
const thinking = [
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "plan" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "sig" },
  },
  { type: "content_block_stop", index: 0 },
];
it("dry-runs the whole check offline: phase switch, compaction, continuation in 4 sends", async () => {
  const bodies: Record<string, unknown>[] = [];
  const responses = [
    sse([
      start,
      ...thinking,
      {
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "tool_use",
          id: "toolu_1",
          name: "SkipPlan",
          input: {},
        },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: {
          type: "input_json_delta",
          partial_json: '{"reason":"binding check"}',
        },
      },
      { type: "content_block_stop", index: 1 },
      ...stop("tool_use"),
    ]),
    sse([
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "done" },
      },
      { type: "content_block_stop", index: 0 },
      ...stop("end_turn"),
    ]),
    sse([
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "compaction",
          content: "summary",
          signature: "csig",
        },
      },
      { type: "content_block_stop", index: 0 },
      ...stop("compaction"),
    ]),
    sse([
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      },
      { type: "content_block_stop", index: 0 },
      ...stop("end_turn"),
    ]),
  ];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_u, init) => {
    bodies.push(JSON.parse(String(init!.body)));
    return responses.shift()!;
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const { main } = await import("./thinking-binding.js");
  const report = (await main(["--yes"], {
    fetcher,
    reserve: async () => 1,
    getAccessToken: async () => "test-token",
  })) as Record<string, unknown>;
  log.mockRestore();
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(report.passed).toBe(true);
  expect(report.workflow).toMatchObject({ phaseSwitched: true, requests: 2 });
  // 段階をまたいでも system と tools が同じで、前の thinking をそのまま返している
  expect(bodies[1]!.system).toEqual(bodies[0]!.system);
  expect(bodies[1]!.tools).toEqual(bodies[0]!.tools);
  expect(JSON.stringify(bodies[1]!.messages)).toContain('"signature":"sig"');
  // 圧縮要求と、ブロックを先頭にした継続
  expect(bodies[2]!.compaction).toEqual({ type: "summarize" });
  expect(bodies[2]!.system).toEqual(bodies[1]!.system);
  expect(bodies[2]!.tools).toEqual(bodies[1]!.tools);
  expect(bodies[3]!.system).toEqual(bodies[2]!.system);
  expect(bodies[3]!.tools).toEqual(bodies[2]!.tools);
  const first = (bodies[3]!.messages as { content: { type: string }[] }[])[0]!;
  expect(first.content[0]!.type).toBe("compaction");
  for (const body of bodies)
    expect(body.thinking).toMatchObject({
      block_binding: { prefix_mismatch_behavior: "error" },
    });
  process.exitCode = 0;
});
