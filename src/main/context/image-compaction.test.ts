import { expect, it } from "vitest";
import { compactHistory, contextView } from "./compactor.js";
import { prepareProviderHistory } from "./provider-compactor.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import type { Message } from "../core/types.js";
import image from "../../../test/fixtures/images/pixel.js";
const messages: Message[] = [
  { role: "user", content: [{ type: "image", ...image }] },
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "r", name: "Read", input: { path: "a.png" } },
    ],
  },
  {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolUseId: "r",
        content: [{ type: "image", ...image }],
      },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "old answer" }] },
  { role: "user", content: [{ type: "text", text: "recent" }] },
  { role: "assistant", content: [{ type: "text", text: "recent answer" }] },
  { role: "user", content: [{ type: "text", text: "latest" }] },
];
it("removes covered images only at checkpoint boundaries and retains original history", () => {
  const saved = structuredClone(messages);
  expect(contextView(messages)).toBe(messages);
  const checkpoint = compactHistory(messages)!;
  expect(JSON.stringify(contextView(messages, checkpoint))).not.toContain(
    image.data,
  );
  expect(messages).toEqual(saved);
  expect(contextView(messages, checkpoint).slice(1)).toEqual(
    messages.slice(checkpoint.covered),
  );
});
it("does not embed image bytes in the Codex summary request or the resulting view", async () => {
  let summaryInput = "";
  const provider = new FakeProvider({
    provider: "codex",
    script: [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "summary" }],
        },
        stopReason: "end_turn",
      },
    ],
    onRequest: (r) => {
      summaryInput = JSON.stringify(r.messages);
    },
  });
  // Exercise the actual provider compactor with a fixture-backed local provider.
  Object.defineProperty(provider, "offline", { value: false });
  const saved = structuredClone(messages);
  const result = await prepareProviderHistory(messages, {
    provider,
    model: "gpt-6-luna",
    system: "",
    tools: [],
    threshold: 0.8,
    force: true,
    signal: new AbortController().signal,
  });
  expect(result.compacted).toBe(true);
  expect(summaryInput).not.toContain(image.data);
  expect(JSON.stringify(result.messages)).not.toContain(image.data);
  expect(messages).toEqual(saved);
});
