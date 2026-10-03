import { expect, it } from "vitest";
import { itemsFromMessages } from "./transcript.js";
import { parseQuestionChoices } from "../../shared/questions.js";
import { applyEvent } from "../../renderer/state/store.js";

it.each([
  ["Permission denied by user", true, "denied"],
  ["File not found", true, "error"],
  ["Permission denied by user", false, "ok"],
] as const)("restores %s as %s / %s", (content, isError, status) => {
  const items = itemsFromMessages([
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "read",
          name: "Read",
          input: { path: "a.txt" },
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolUseId: "read", content, isError }],
    },
  ]);
  expect(items[0]).toMatchObject({ kind: "tool", tool: "Read", status });
});

it("restores the same question choices as live tool events", () => {
  const input = {
    question: "どうしますか？",
    options: ["修正する", "調査する"],
  };
  const history = itemsFromMessages([
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "q", name: "AskUserQuestion", input }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "q",
          content: "確認が必要です",
          isError: false,
        },
      ],
    },
  ]);
  let live = applyEvent(
    { app: null, views: {} },
    {
      type: "tool_call",
      sessionId: "s",
      receiptId: "q",
      provider: "claude",
      tool: "AskUserQuestion",
      input,
    },
  );
  live = applyEvent(live, {
    type: "tool_result",
    sessionId: "s",
    receiptId: "q",
    isError: false,
  });
  expect(history[0]).toMatchObject({ question: input, status: "ok" });
  expect(live.views.s!.items[0]).toMatchObject({
    question: input,
    status: "ok",
  });
});

it.each([
  null,
  {},
  { question: "q" },
  { question: "q", options: ["one"] },
  { question: "q", options: ["one", " "] },
  { question: "q", options: ["one", 2] },
  { question: "q", options: Array(6).fill("one") },
  { question: "q", options: ["one", "x".repeat(301)] },
  { question: "x".repeat(4001), options: ["one", "two"] },
])("does not create buttons for malformed choices: %j", (input) => {
  expect(parseQuestionChoices(input)).toBeUndefined();
});
