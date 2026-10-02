import { expect, it } from "vitest";
import { runTurn } from "./loop.js";
import { failure, type ErrorKind } from "../tools/errors.js";
import { type Provider, type ProviderEvent } from "../providers/provider.js";
import { type Tool } from "../tools/registry.js";
import { toReceipt } from "../session/context.js";

async function run(sequence: (ErrorKind | "ok")[]) {
  let requests = 0,
    executions = 0;
  const provider: Provider = {
    id: "claude",
    models: () => [],
    async *stream() {
      requests++;
      yield {
        type: "message_done",
        stopReason: executions < sequence.length ? "tool_use" : "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        message: {
          role: "assistant",
          content:
            executions < sequence.length
              ? [
                  {
                    type: "tool_use",
                    id: `call-${requests}`,
                    name: "Read",
                    input: { path: `${requests}.txt` },
                  },
                ]
              : [{ type: "text", text: "done" }],
        },
      } as ProviderEvent;
    },
  };
  const tool: Tool = {
    spec: { name: "Read", description: "test", inputSchema: {} },
    readOnly: true,
    validate: async () => undefined,
    execute: async () => {
      const kind = sequence[executions++]!;
      return kind === "ok"
        ? { content: "done" }
        : {
            content: failure(kind).message,
            isError: true,
            error: failure(kind),
          };
    },
  };
  const result = await runTurn(
    {
      provider,
      model: "test",
      system: "test",
      messages: [],
      tools: new Map([["Read", tool]]),
      permission: async () => true,
      afterStep: async (step, ctx) =>
        step === "receipt" && ctx.calls.length
          ? { kind: "inject", message: "keep working" }
          : { kind: "continue" },
    },
    new AbortController().signal,
  );
  return { result, requests, executions };
}
it.each([
  "missing_cli",
  "not_found",
  "denied",
  "timeout",
  "invalid_args",
  "failed",
] as const)(
  "asks after three %s failures without a fourth communication and records the kind",
  async (kind) => {
    const { result, requests, executions } = await run([
      kind,
      kind,
      kind,
      kind,
    ]);
    expect(result.stopCause).toBe("awaiting_user");
    expect(requests).toBe(3);
    expect(executions).toBe(3);
    expect(JSON.stringify(result.messages)).toContain("3回");
    const receipts = result.receipts.filter((r) => r.tool);
    expect(receipts.every((r) => r.error?.kind === kind)).toBe(true);
    const saved = toReceipt(receipts[0]!, "session", "#1");
    expect(saved.error?.kind).toBe(kind);
    expect(saved.summary).toContain(kind);
  },
);
it("resets after a successful call or a change of kind", async () => {
  const { result, executions } = await run([
    "not_found",
    "not_found",
    "ok",
    "not_found",
    "not_found",
    "denied",
    "denied",
    "ok",
  ]);
  expect(result.stopCause).toBe("end_turn");
  expect(executions).toBe(8);
});
