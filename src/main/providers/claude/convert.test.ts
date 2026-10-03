import { describe, expect, it } from "vitest";
import { type ProviderRequest } from "../provider.js";
import { toClaudeRequest } from "./convert.js";

const request: ProviderRequest = {
  model: "claude-opus-5-5",
  system: "",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
};

describe("Claude max_tokens", () => {
  it("defaults to 32000 when the request has no output limit", () => {
    expect(toClaudeRequest(request).max_tokens).toBe(32000);
  });
  it("keeps an explicit output limit", () => {
    expect(
      toClaudeRequest({ ...request, maxOutputTokens: 2048 }).max_tokens,
    ).toBe(2048);
  });
});
