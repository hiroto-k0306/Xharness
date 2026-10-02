import { expect, it } from "vitest";
import {
  requestView,
  responseView,
  receiptInputView,
  receiptOutputView,
  initialRequest,
  recordedStatus,
  toolName,
} from "./report-readable.js";

const message = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});
it("shows only additions to the previous model request without repeating earlier instructions", () => {
  const previous = {
    system: "long system instructions",
    messages: [message("initial request")],
    tools: [{ name: "Read", inputSchema: { secretLookingSchema: "schema" } }],
  };
  const request = {
    ...previous,
    messages: [
      ...previous.messages,
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "internal-id",
            content: JSON.stringify({
              path: "a.txt",
              content: "file body",
              modifiedAt: "internal-time",
            }),
          },
        ],
      },
    ],
  };
  const html = requestView(request, previous);
  expect(html).toContain("前回から追加した情報 1 件");
  expect(html).toContain("ハーネスから返す実行結果");
  expect(html).toContain("file body");
  expect(html).toContain("Read · ファイルを読む");
  for (const value of [
    "initial request",
    "long system instructions",
    "internal-id",
    "internal-time",
    "secretLookingSchema",
  ])
    expect(html).not.toContain(value);
});
it("does not fabricate a delta when compaction or a provider switch changes history", () => {
  const html = requestView(
    { messages: [message("rewritten context"), message("latest request")] },
    { messages: [message("old context")] },
  );
  expect(html).toContain("履歴の構成が変わっています");
  expect(html).toContain("latest request");
  expect(html).not.toContain("rewritten context");
  expect(html).not.toContain("前回から追加した情報");
});
it("explains model tool requests in Japanese and renders text as inert content", () => {
  const html = responseView({
    role: "assistant",
    content: [
      { type: "text", text: "<script>unsafe</script>" },
      {
        type: "tool_use",
        id: "hidden-id",
        name: "Read",
        input: { path: "a.txt" },
      },
      { type: "reasoning", payload: "hidden-thinking" },
    ],
  });
  expect(html).toContain("LLMの返答");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("LLMが要求した操作：Read · ファイルを読む");
  expect(html).not.toContain("hidden-id");
  expect(html).not.toContain("hidden-thinking");
});
it("bounds previews and handles unknown records while leaving details to the original JSON", () => {
  const html =
    receiptInputView({ unusual: "opaque-input" }) +
    receiptOutputView("x".repeat(1300));
  expect(html).toContain("続きは詳細JSON");
  expect(html).not.toContain("x".repeat(1201));
  expect(html).toContain("引数の詳細はJSON欄");
  expect(requestView(undefined)).toContain("未記録");
  expect(responseView({ content: [null] })).toContain("対応していないブロック");
  expect(toolName("toString")).toBe("toString");
  expect(recordedStatus("model: __proto__")).toBe("");
  expect(receiptInputView({ toString: "inherited-name" })).not.toContain(
    "inherited-name",
  );
});
it("recovers an initial request from the model input when no separate history file exists", () => {
  expect(
    initialRequest([], [{ messages: [message("original request")] }]),
  ).toContain("original request");
  expect(
    initialRequest(
      [message("saved request")],
      [{ messages: [message("other request")] }],
    ),
  ).toContain("saved request");
});
