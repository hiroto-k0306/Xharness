import { it, expect, vi } from "vitest";
import {
  shellHooks,
  parseShellHooks,
  projectHookApproval,
} from "./shell-hooks.js";
import { hookSnapshot } from "./step-hooks.js";
import {
  runTurn,
  type Receipt,
  type HookContext,
  type StepName,
} from "../core/loop.js";
import { type Tool } from "../tools/registry.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";

const signal = () => new AbortController().signal;
const ctx = (path = "src/a.ts"): HookContext =>
  hookSnapshot({
    round: 1,
    messages: [],
    calls: [{ id: "1", name: "Write", input: { path } }],
  });
const tool = (isError = false): Tool => ({
  spec: { name: "Bash", description: "test", inputSchema: {} },
  readOnly: false,
  validate: async () => undefined,
  execute: vi.fn(async () => ({ content: "lint output SECRET", isError })),
});
const hooks = (values: unknown) => parseShellHooks(values, false);
it.each([
  "context",
  "model",
  "tool_use",
  "gate",
  "act",
  "receipt",
] as StepName[])("runs configured hooks at both sides of %s", async (step) => {
  const bash = tool(),
    receipts: Receipt[] = [];
  const h = shellHooks({
    hooks: hooks(
      ["before", "after"].map((timing) => ({
        id: timing,
        step,
        timing,
        command: "test",
      })),
    ),
    cwd: process.cwd(),
    agent: "main",
    phase: () => "off",
    bash,
    approve: async () => true,
    onReceipt: (r) => receipts.push(r),
  });
  await h.beforeStep(step, ctx(), signal());
  await h.afterStep(step, ctx(), signal());
  expect(bash.execute).toHaveBeenCalledTimes(2);
  expect(receipts.map((r) => r.timing)).toEqual(["before", "after"]);
  expect(receipts.every((r) => !Number.isNaN(Date.parse(r.completedAt)))).toBe(
    true,
  );
});
it("requires all conditions and safely quotes file arguments", async () => {
  const bash = tool();
  const h = shellHooks({
    hooks: hooks([
      {
        id: "lint",
        step: "act",
        timing: "after",
        when: {
          tools: ["Write"],
          agents: ["main"],
          phases: ["implement"],
          pathGlob: "src/**",
        },
        command: "lint {{files}}",
      },
    ]),
    cwd: process.cwd(),
    agent: "main",
    phase: () => "implement",
    bash,
    approve: async () => true,
  });
  await h.afterStep("act", ctx("test/no.ts"), signal());
  expect(bash.execute).not.toHaveBeenCalled();
  await h.afterStep("act", ctx("src/a';$(whoami).ts"), signal());
  expect(bash.execute).toHaveBeenCalledWith(
    { command: "lint 'src/a'';$(whoami).ts'", timeoutSec: 60 },
    expect.any(AbortSignal),
  );
  expect(Object.isFrozen(ctx().calls[0]?.input)).toBe(true);
});
it("blocks before act and injects failed output with secrets redacted", async () => {
  const bash = tool(true);
  const h = shellHooks({
    hooks: hooks([
      {
        id: "protect",
        step: "act",
        timing: "before",
        when: { pathGlob: "migrations/**" },
        onMatch: "block",
        reason: "manual only",
      },
      {
        id: "lint",
        step: "act",
        timing: "after",
        command: "lint",
        onFailure: "inject",
      },
    ]),
    cwd: process.cwd(),
    agent: "main",
    phase: () => "implement",
    bash,
    approve: async () => true,
    redact: (s) => s.replaceAll("SECRET", "MASKED"),
  });
  expect(await h.beforeStep("act", ctx("migrations/a.sql"), signal())).toEqual({
    kind: "block",
    reason: "manual only",
  });
  expect(bash.execute).not.toHaveBeenCalled();
  expect(await h.afterStep("act", ctx(), signal())).toEqual({
    kind: "inject",
    message: "lint: lint output MASKED",
  });
});
it("shares project approval and never executes denied hooks", async () => {
  const configured = parseShellHooks(
    [{ id: "check", step: "model", timing: "before", command: "test" }],
    true,
  );
  const approve = vi.fn(async () => false),
    gate = projectHookApproval(configured, approve),
    bash = tool();
  const h = shellHooks({
    hooks: configured,
    cwd: process.cwd(),
    agent: "main",
    phase: () => "off",
    bash,
    approve: gate,
  });
  const result = await Promise.all([
    h.beforeStep("model", ctx(), signal()),
    h.beforeStep("model", ctx(), signal()),
  ]);
  expect(approve).toHaveBeenCalledTimes(1);
  expect(bash.execute).not.toHaveBeenCalled();
  expect(result.every((r) => r.kind === "stop")).toBe(true);
});
it("block closes pending tool IDs without executing a write", async () => {
  const write = tool();
  const h = shellHooks({
    hooks: hooks([
      {
        id: "block",
        step: "act",
        timing: "before",
        onMatch: "block",
        reason: "protected",
      },
    ]),
    cwd: process.cwd(),
    agent: "main",
    phase: () => "off",
    bash: tool(),
    approve: async () => true,
  });
  const provider = new FakeProvider({
    script: [
      {
        type: "message",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "w", name: "Write", input: { path: "a" } },
          ],
        },
      },
      {
        type: "message",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      },
    ],
  });
  const result = await runTurn(
    {
      provider,
      model: "claude-opus-5-5",
      system: "test",
      messages: [],
      tools: new Map([["Write", write]]),
      permission: async () => true,
      ...h,
    },
    signal(),
  );
  expect(write.execute).not.toHaveBeenCalled();
  expect(JSON.stringify(result.messages)).toContain('"toolUseId":"w"');
  expect(JSON.stringify(result.messages)).toContain("protected");
});
it.each([
  { timing: "after", onMatch: "block", reason: "no" },
  { timing: "before", command: "check", timeoutSec: 0 },
  { timing: "before", command: "check", when: { tools: "Write" } },
  { timing: "before", command: "check", onFailure: "ignore" },
])("rejects invalid configuration %j", (extra) => {
  expect(() => hooks([{ id: "invalid", step: "act", ...extra }])).toThrow();
});
