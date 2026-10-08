import { expect, it } from "vitest";
import { communicationInput, communicationText } from "./communication.js";

it("removes credentials and thinking before storing either direction", () => {
  const result = communicationText({
    instruction: "inspect add.mjs",
    history: [
      { text: 'api_key="private-one" Authorization: Bearer private-two' },
    ],
    data: { account_id: "private-three", refreshToken: "private-four" },
    response: [{ type: "thinking", text: "private-thought" }],
    signature: "private-signature",
    text: '<thinking>private-inner</thinking> {"password":"private-five"}',
  });
  expect(result.text).toContain("inspect add.mjs");
  expect(result.text).not.toContain("private-");
  expect(result.truncated).toBe(false);
});
it("bounds snapshots after sanitization and preserves Unicode", () => {
  const result = communicationText("あ".repeat(23_998) + "😀tail");
  expect(result.truncated).toBe(true);
  expect(result.text.length).toBeLessThanOrEqual(24_000);
  expect(result.text).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(communicationInput({ question: "hello" })).toMatchObject({
    boundary: "xharness-official-agent",
    input: { truncated: false },
  });
});
