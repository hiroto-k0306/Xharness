import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { Transcript } from "./Transcript.js";
import { Receipts } from "./Activity.js";
import { type TranscriptItem } from "../../shared/ipc.js";
import { applyEvent } from "../state/store.js";

const todos = [
  { content: "<script>調査</script>", status: "completed" as const },
  { content: "修正", status: "in_progress" as const },
  { content: "検証", status: "pending" as const },
];
it("renders accepted todo snapshots in Japanese and escapes content", () => {
  const item: TranscriptItem = {
    kind: "tool",
    id: "todo",
    tool: "TodoWrite",
    summary: "TodoWrite",
    status: "ok",
    todos,
  };
  const { rerender } = render(
    <Transcript items={[item]} model="fake" running={false} />,
  );
  const list = screen.getByRole("region", { name: "進捗リスト" });
  expect(list).toHaveTextContent("1/3 完了");
  expect(list).toHaveTextContent("進行中");
  expect(list).toHaveTextContent("未着手");
  expect(list.querySelector("script")).toBeNull();
  rerender(
    <Transcript
      items={[{ ...item, status: "error" }]}
      model="fake"
      running={false}
    />,
  );
  expect(screen.queryByRole("region", { name: "進捗リスト" })).toBeNull();
  rerender(
    <Transcript
      items={[{ ...item, todos: [] }]}
      model="fake"
      running={false}
    />,
  );
  expect(screen.getByText("進捗リストは空です")).toBeInTheDocument();
});
it("shows the list in receipt details including child snapshots", () => {
  render(
    <Receipts
      receipts={[
        {
          id: "#1",
          sessionId: "s",
          agentId: "child",
          ts: 0,
          provider: "harness",
          kind: "tool",
          tool: "TodoWrite",
          decision: "allow",
          durationMs: 0,
          summary: "TodoWrite",
          input: { todos },
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /receipts ·/ }));
  fireEvent.click(screen.getByRole("button", { name: /#1/ }));
  expect(
    within(screen.getByRole("dialog")).getByRole("region", {
      name: "進捗リスト",
    }),
  ).toHaveTextContent("修正");
});
it("keeps todo input through live call/result and separates sessions", () => {
  let state = applyEvent(
    { app: null, views: {} },
    {
      type: "tool_call",
      sessionId: "parent",
      receiptId: "#1",
      provider: "claude",
      tool: "TodoWrite",
      input: { todos },
    },
  );
  state = applyEvent(state, {
    type: "tool_result",
    sessionId: "parent",
    receiptId: "#1",
    isError: false,
  });
  expect(state.views.parent!.items[0]).toMatchObject({ todos, status: "ok" });
  state = applyEvent(state, {
    type: "tool_call",
    sessionId: "child",
    receiptId: "#2",
    provider: "codex",
    tool: "TodoWrite",
    input: { todos: [] },
  });
  expect(state.views.parent!.items).toHaveLength(1);
  expect(state.views.child!.items[0]).toMatchObject({ todos: [] });
});
