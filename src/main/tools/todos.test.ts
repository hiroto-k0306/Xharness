import { expect, it, vi } from "vitest";
import { todoTools } from "./todos.js";
import { runTurn } from "../core/loop.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { itemsFromMessages } from "../session/transcript.js";
import { SessionStore } from "../session/store.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tool = todoTools().get("TodoWrite")!;
it.each([
  null,
  {},
  { todos: null },
  { todos: [{}] },
  { todos: [{ content: " ", status: "pending" }] },
  { todos: [{ content: "test", status: "done" }] },
])("rejects invalid input with a fixed repairable error: %j", async (input) => {
  expect(await tool.validate(input)).toContain("todos");
  expect(await tool.execute(input, new AbortController().signal)).toMatchObject(
    { isError: true, error: { kind: "invalid_args" } },
  );
});
it("accepts empty lists, multiple in_progress and large lists/text without limits", async () => {
  for (const todos of [
    [],
    [
      { content: "a", status: "in_progress" },
      { content: "b", status: "in_progress" },
    ],
    Array.from({ length: 300 }, () => ({
      content: "x".repeat(40000),
      status: "pending",
    })),
  ]) {
    expect(await tool.validate({ todos })).toBeUndefined();
    expect(
      (await tool.execute({ todos }, new AbortController().signal)).isError,
    ).toBeUndefined();
  }
});
it("always allows replacement, records each full snapshot and restores through persisted history", async () => {
  const snapshots = [
    [{ content: "first", status: "in_progress" }],
    [{ content: "second", status: "completed" }],
    [],
  ];
  const script: FakeStep[] = snapshots.map((todos, i) => ({
    type: "message",
    stopReason: "tool_use",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          name: "TodoWrite",
          id: `todo-${i}`,
          input: { todos },
        },
      ],
    },
  }));
  script.push({
    type: "message",
    stopReason: "end_turn",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
  });
  const permission = vi.fn(async () => false);
  const result = await runTurn(
    {
      provider: new FakeProvider({ script }),
      model: "fake",
      system: "test",
      tools: todoTools(),
      messages: [],
      permission,
    },
    new AbortController().signal,
  );
  expect(permission).not.toHaveBeenCalled();
  expect(result.stopCause).toBe("end_turn");
  expect(
    result.receipts.filter((r) => r.tool === "TodoWrite").map((r) => r.input),
  ).toEqual(snapshots.map((todos) => ({ todos })));
  const home = await mkdtemp(join(tmpdir(), "xh-todos-"));
  await new SessionStore(home).append("test", result.messages, (s) => s);
  const restored = itemsFromMessages(
    await new SessionStore(home).messages("test"),
  );
  expect(
    restored
      .filter((i) => i.kind === "tool")
      .map((i) =>
        i.kind === "tool" ? { todos: i.todos, status: i.status } : null,
      ),
  ).toEqual(snapshots.map((todos) => ({ todos, status: "ok" })));
});
