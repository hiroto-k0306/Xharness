import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import image from "../../../test/fixtures/images/pixel.js";
import { fileTools, FileAccess } from "./files.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { runTurn } from "../core/loop.js";
import { toClaudeRequest } from "../providers/claude/convert.js";
import { toCodexInput } from "../providers/codex/convert.js";
import { traceJson } from "../core/trace.js";
import { SessionStore } from "../session/store.js";
it("Read returns binary images intact through the loop and both provider conversions, while receipts omit bytes", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-read-image-"));
  await writeFile(join(home, "pixel.png"), Buffer.from(image.data, "base64"));
  const tools = fileTools(new FileAccess(home));
  const provider = new FakeProvider({
    script: [
      {
        type: "message",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_image",
              name: "Read",
              input: { path: "pixel.png" },
            },
          ],
        },
      },
      { type: "fixture", name: "phase1-haiku-text" },
    ],
  });
  const result = await runTurn(
    {
      provider,
      model: "claude-haiku-4-5",
      system: "test",
      messages: [],
      tools,
      permission: async () => true,
    },
    new AbortController().signal,
  );
  const toolResult = result.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === "tool_result")!;
  expect(toolResult).toMatchObject({
    content: [expect.anything(), { type: "image", ...image }],
  });
  const request = {
    model: "claude-haiku-4-5",
    system: "test",
    messages: result.messages,
    tools: [],
  };
  expect(JSON.stringify(toClaudeRequest(request))).toContain(image.data);
  expect(JSON.stringify(toCodexInput(result.messages))).toContain(
    `data:${image.mediaType};base64,${image.data}`,
  );
  expect(
    JSON.stringify(result.receipts.find((r) => r.tool === "Read")),
  ).not.toContain(image.data);
  expect(traceJson(result.receipts, (s) => s)).not.toContain(image.data);
  expect(JSON.stringify(result.receipts)).not.toContain(image.data);
  const store = new SessionStore(home);
  await store.append("test", result.messages, (s) =>
    s.replaceAll(image.data, "masked"),
  );
  expect(JSON.stringify(await store.messages("test"))).toContain(image.data);
});
it("rejects unsupported/truncated image files as a fixed structured error", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-read-image-error-"));
  await writeFile(join(home, "bad.png"), "not an image");
  const result = await fileTools(new FileAccess(home))
    .get("Read")!
    .execute({ path: "bad.png" }, new AbortController().signal);
  expect(result).toMatchObject({
    isError: true,
    error: { kind: "invalid_args" },
  });
  expect(result.blocks).toBeUndefined();
});
