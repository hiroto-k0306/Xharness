import { expect, it } from "vitest";
import { toolResultItems } from "./convert.js";
import { loadMainConfig } from "../../config/config.js";
const block = {
  type: "tool_result" as const,
  toolUseId: "call_read",
  content: [
    { type: "text" as const, text: "image info" },
    { type: "image" as const, mediaType: "image/png", data: "YWJj" },
  ],
};
it("keeps image output as the default and provides a subsequent user message fallback", () => {
  expect(toolResultItems(block, "output")).toEqual([
    {
      type: "function_call_output",
      call_id: "call_read",
      output: [
        { type: "input_text", text: "image info" },
        { type: "input_image", image_url: "data:image/png;base64,YWJj" },
      ],
    },
  ]);
  expect(toolResultItems(block, "user_message")).toEqual([
    {
      type: "function_call_output",
      call_id: "call_read",
      output: "image info",
    },
    {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,YWJj" },
      ],
    },
  ]);
  expect(
    toolResultItems({ ...block, content: "plain" }, "user_message"),
  ).toHaveLength(1);
});
it.each(["output", "user_message", "invalid"])(
  "loads toolImageMode %s with safe fallback",
  async (mode) => {
    const config = await loadMainConfig(
      "unused",
      async () => `providers:\n  codex:\n    toolImageMode: ${mode}`,
    );
    expect(config.providers.codex.toolImageMode).toBe(
      mode === "user_message" ? mode : "output",
    );
    expect(config.warnings.length).toBe(mode === "invalid" ? 1 : 0);
  },
);
