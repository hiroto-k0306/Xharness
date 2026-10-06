import { expect, it, vi } from "vitest";
import type {
  Query,
  SDKMessage,
  Options,
} from "@anthropic-ai/claude-agent-sdk";
import {
  approvePersonalQuery,
  checkPersonalSdk,
  personalSdkBinding,
  type PersonalStart,
} from "./personal-sdk.js";
import { ClaudeProposals } from "./claude.js";
const usage = (enabled: boolean | undefined) =>
  ({
    subscription_type: "pro",
    rate_limits_available: true,
    rate_limits: {
      extra_usage: enabled === undefined ? null : { is_enabled: enabled },
    },
  }) as Awaited<
    ReturnType<
      Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]
    >
  >;
function fixture(enabled: boolean | undefined = false) {
  const prompts: string[] = [],
    close = vi.fn();
  let captured: Options | undefined;
  const accountInfo = vi.fn(async () => ({
    apiProvider: "firstParty" as const,
    subscriptionType: "pro",
  }));
  const getUsage = vi.fn(async () => usage(enabled));
  const start: PersonalStart = (request) => {
    captured = request.options;
    return {
      accountInfo,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: getUsage,
      close,
      async *[Symbol.asyncIterator]() {
        for await (const event of request.prompt)
          prompts.push(String(event.message.content));
        yield {
          type: "result",
          subtype: "success",
          structured_output: { answer: "OK", actions: [] },
        } as unknown as SDKMessage;
      },
    };
  };
  return {
    start,
    prompts,
    close,
    accountInfo,
    getUsage,
    captured: () => captured,
  };
}
const input = {
  taskId: "task",
  sessionId: "session",
  requestId: "request",
  model: "haiku",
  instructions: "Fixture",
  history: [{ role: "user" as const, content: "OK" }],
  tools: [],
  timeoutMs: 500,
};
it("checks the official typed account/usage APIs without releasing any inference prompt", async () => {
  const f = fixture();
  expect(
    await checkPersonalSdk(".", new AbortController().signal, f.start),
  ).toBe(true);
  expect(f.prompts).toEqual([]);
  expect(f.getUsage).toHaveBeenCalledWith({ skipBehaviors: true });
  expect(f.close).toHaveBeenCalled();
  expect(f.captured()).toMatchObject({
    tools: [],
    settingSources: [],
    persistSession: false,
  });
});
it.each([true, undefined])(
  "blocks %s overage before the model sees the prompt",
  async (enabled) => {
    const f = fixture(enabled);
    f.getUsage.mockResolvedValue(usage(enabled));
    const result = await new ClaudeProposals(
      personalSdkBinding(".", f.start),
    ).infer(input, new AbortController().signal);
    expect(result.status).toBe("failed");
    expect(f.prompts).toEqual([]);
    expect(f.close).toHaveBeenCalled();
  },
);
it("rechecks route and releases exactly one prompt after approval", async () => {
  const f = fixture();
  expect(
    (
      await new ClaudeProposals(personalSdkBinding(".", f.start)).infer(
        input,
        new AbortController().signal,
      )
    ).status,
  ).toBe("completed");
  expect(f.prompts).toHaveLength(1);
  expect(f.accountInfo).toHaveBeenCalledTimes(1);
  expect(f.getUsage).toHaveBeenCalledTimes(1);
});
it.each([
  {
    apiProvider: "firstParty" as const,
    subscriptionType: "pro",
    apiKeySource: "env",
  },
  { apiProvider: "bedrock" as const, subscriptionType: "pro" },
  { apiProvider: "firstParty" as const },
])(
  "rejects non-subscription route %j before requesting subscriber usage",
  async (account) => {
    const getUsage = vi.fn();
    await expect(
      approvePersonalQuery({
        accountInfo: async () => account,
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: getUsage,
        close() {},
        async *[Symbol.asyncIterator]() {},
      }),
    ).rejects.toMatchObject({ code: "unconfigured" });
    expect(getUsage).not.toHaveBeenCalled();
  },
);
it("cancels uncooperative control requests and closes without late availability", async () => {
  const f = fixture();
  f.accountInfo.mockImplementation(() => new Promise(() => {}));
  const abort = new AbortController();
  const pending = checkPersonalSdk(".", abort.signal, f.start);
  abort.abort();
  expect(await pending).toBe(false);
  expect(f.close).toHaveBeenCalled();
  expect(f.prompts).toEqual([]);
});
