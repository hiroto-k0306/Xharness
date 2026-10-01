import { expect, it } from "vitest";
import { itemsFromMessages } from "./transcript.js";

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
