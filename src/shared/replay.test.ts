import { expect, it } from "vitest";
import { buildReceiptReplay } from "./replay.js";

const receipt = (ts = 2000) => ({
  id: "#0007",
  sessionId: "test",
  ts,
  provider: "claude",
  kind: "model_call",
  durationMs: 10,
  summary: "Haiku: end_turn",
  input: { messages: ["original"] },
  usage: { inputTokens: 12, outputTokens: 3 },
});
it("keeps authentication refresh results in offline replay", () => {
  const replay = buildReceiptReplay([
    {
      ...receipt(),
      kind: "auth_refresh",
      summary: "認証を更新しました",
      input: { result: "success" },
    },
  ]);
  expect(replay.skipped).toBe(0);
  expect(replay.frames[0]?.receipt.kind).toBe("auth_refresh");
});
it("preserves append order, child ownership and duplicate ids in an independent snapshot", () => {
  const original = [receipt(), { ...receipt(1000), agentId: "worker" }];
  const replay = buildReceiptReplay(original);
  original[0]!.input.messages.push("changed");
  original[0]!.summary = "changed";
  expect(replay.frames.map((f) => f.recordedAt)).toEqual([
    "1970-01-01T00:00:02.000Z",
    "1970-01-01T00:00:01.000Z",
  ]);
  expect(replay.frames[0]!.receipt.summary).toBe("Haiku: end_turn");
  expect(replay.frames[0]!.receipt.input).toEqual({ messages: ["original"] });
  expect(replay.frames[1]!.receipt.agentId).toBe("worker");
  expect(replay.frames[1]!.position).toBe(1);
});
it("remasks sensitive fields and token text while retaining usage counts", () => {
  const replay = buildReceiptReplay(
    [
      {
        ...receipt(),
        command: "never execute",
        input: {
          Authorization: "Bearer private",
          chatgpt_account_id: "account-private",
          accessToken: "token-private",
        },
        output: "sk-ant-privatevalue eyJabc.abc.signature other-private",
      },
    ],
    (s) => s.replaceAll("other-private", "masked"),
  );
  const json = JSON.stringify(replay);
  expect(json).not.toMatch(
    /Bearer private|account-private|token-private|sk-ant-privatevalue|eyJabc|other-private|never execute/,
  );
  expect(replay.frames[0]!.receipt.usage).toEqual({
    inputTokens: 12,
    outputTokens: 3,
  });
  expect(replay.frames[0]!.receipt.output).toContain("masked");
});
it("counts invalid and unsupported records without fabricating a STEP", () => {
  const replay = buildReceiptReplay([
    null,
    { ...receipt(), kind: "execute" },
    { ...receipt(), ts: 9e20 },
    { ...receipt(), sessionId: "../escape" },
    { ...receipt(), durationMs: -1 },
    { ...receipt(), usage: { inputTokens: "12", outputTokens: 3 } },
    receipt(),
  ]);
  expect(replay.skipped).toBe(6);
  expect(replay.frames).toHaveLength(1);
  expect(replay.frames[0]!.position).toBe(6);
});
it("bounds record count, individual size and aggregate size", () => {
  expect(() => buildReceiptReplay(Array(10001).fill(receipt()))).toThrow(
    "Too many",
  );
  expect(() =>
    buildReceiptReplay([{ ...receipt(), output: "x".repeat(2_000_001) }]),
  ).toThrow("size limit");
  expect(() =>
    buildReceiptReplay(
      Array(17).fill({ ...receipt(), output: "x".repeat(1_000_000) }),
    ),
  ).toThrow("size limit");
});
it("skips circular input and masks that invalidate JSON with no raw error content", () => {
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  expect(buildReceiptReplay([{ ...receipt(), input: cyclic }]).skipped).toBe(1);
  expect(
    buildReceiptReplay([receipt()], () => "private invalid json").skipped,
  ).toBe(1);
});
