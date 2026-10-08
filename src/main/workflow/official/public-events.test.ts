import { expect, it } from "vitest";
import {
  claudePublicEvents,
  codexPublicEvents,
  publicEventRecorder,
} from "./public-events.js";
import { communicationInput } from "./communication.js";
it("selects Claude responses/tool content, separates parents and excludes private event fields", () => {
  const events = claudePublicEvents({
    type: "assistant",
    parent_tool_use_id: "parent-tool",
    message: {
      id: "message",
      model: "fixture-model",
      account_id: "private-account",
      content: [
        { type: "thinking", thinking: "private-thinking" },
        { type: "text", text: "Read the file" },
        {
          type: "tool_use",
          id: "read-1",
          name: "Read",
          input: { file_path: "add.mjs", api_key: "private-key" },
        },
      ],
    },
  });
  expect(events.map((e) => e.kind)).toEqual(["response", "tool_request"]);
  expect(events[0]?.parentId).toBe("parent-tool");
  expect(JSON.stringify(events)).not.toContain("private-");
  const result = claudePublicEvents({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "read-1",
          content: [
            { type: "text", text: "return a - b" },
            { type: "image", data: "private-picture" },
          ],
        },
      ],
    },
  });
  expect(result[0]?.body?.text).toContain("return a - b");
  expect(JSON.stringify(result)).not.toContain("private-picture");
  expect(
    claudePublicEvents({ type: "system", authorization: "private-auth" }),
  ).toEqual([]);
});
it("records Codex completed items without treating unknown status or missing output as success", () => {
  const event = codexPublicEvents("item/completed", {
    item: {
      id: "command",
      type: "commandExecution",
      command: "secret=private-value",
    },
  })[0]!;
  expect(event.status).toBe("unknown");
  expect(event.body?.text).toContain("未提供");
  expect(event.body?.text).not.toContain("private-value");
  expect(
    codexPublicEvents("item/completed", {
      item: { id: "r", type: "reasoning", text: "private-thought" },
    }),
  ).toEqual([]);
  expect(
    codexPublicEvents("account/updated", { account: "private-account" }),
  ).toEqual([]);
  expect(
    codexPublicEvents("item/completed", {
      item: {
        id: "hidden",
        type: "agentMessage",
        phase: "analysis",
        text: "private-analysis",
      },
    }),
  ).toEqual([]);
});
it("retains arrival sequence and deduplicates item/turn completion and tool hook copies", () => {
  const communication = communicationInput({ question: "test" }),
    record = publicEventRecorder(communication);
  const item = { id: "answer", type: "agentMessage", text: "Answer" };
  for (const e of codexPublicEvents("item/completed", { item })) record(e);
  for (const e of codexPublicEvents("turn/completed", {
    turn: { id: "turn", status: "completed", items: [item] },
  }))
    record(e);
  expect(communication.events?.map((e) => [e.sequence, e.kind])).toEqual([
    [1, "response"],
    [2, "end"],
  ]);
  record({
    actor: "tool",
    kind: "tool_result",
    itemId: "read",
    status: "completed",
  });
  expect(
    record({
      actor: "tool",
      kind: "tool_result",
      itemId: "read",
      status: "completed",
      body: { text: "duplicate representation", truncated: false },
    }),
  ).toBe(false);
  expect(communication.events).toHaveLength(3);
  record({
    actor: "tool",
    kind: "tool_result",
    itemId: "read",
    parentId: null,
    status: "completed",
  });
  expect(communication.events).toHaveLength(3);
  expect(communication.events?.at(-1)?.parentId).toBeNull();
});
it("bounds event count and content and marks omission only once", () => {
  const c = communicationInput({}),
    record = publicEventRecorder(c);
  for (let i = 0; i < 128; i++)
    record({ actor: "official", kind: "start", itemId: `item-${i}` });
  expect(record({ actor: "official", kind: "end", itemId: "overflow" })).toBe(
    true,
  );
  expect(record({ actor: "official", kind: "end", itemId: "overflow-2" })).toBe(
    false,
  );
  expect(c.events).toHaveLength(128);
  expect(c.eventsOmitted).toBe(true);
  const b = communicationInput({}),
    text = publicEventRecorder(b);
  for (let i = 0; i < 17; i++)
    text({
      actor: "llm",
      kind: "response",
      itemId: `text-${i}`,
      body: { text: "a".repeat(4000), truncated: true },
    });
  expect(b.events).toHaveLength(15);
  expect(b.eventsOmitted).toBe(true);
});
