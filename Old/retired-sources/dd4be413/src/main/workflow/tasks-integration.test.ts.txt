import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkflowRuntime } from "./runtime.js";
import { defaultTools } from "../session/controller.js";
import { loadAgentConfig } from "../agents/definitions.js";
import { Router } from "../core/router.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { ChildRunner } from "../agents/runner.js";
import { SessionStore } from "../session/store.js";
import {
  type Provider,
  type ProviderEvent,
  type ProviderRequest,
} from "../providers/provider.js";

function call(name: string, input: unknown): ProviderEvent {
  return {
    type: "message_done",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: name, name, input }],
    },
  };
}
it("retains all three concurrent child sessions in the saved index", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-child-index-"));
  const cwd = join(home, "project");
  await mkdir(cwd);
  const provider: Provider = {
    id: "claude",
    models: () => new FakeProvider().models(),
    async *stream() {
      yield {
        type: "message_done",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        message: {
          role: "assistant",
          content: [{ type: "text", text: "調査結果" }],
        },
      };
    },
  };
  const runner = new ChildRunner({
    home,
    parentId: "test",
    router: new Router([provider]),
    createTools: (cwd) => defaultTools(cwd, false),
    permission: async () => true,
  });
  const children = await Promise.all(
    ["first", "second", "third"].map((id) =>
      runner.run(
        "explorer",
        { model: "claude:sonnet", tools: ["Read"] },
        "inspect",
        cwd,
        new AbortController().signal,
        undefined,
        id,
      ),
    ),
  );
  const store = new SessionStore(join(home, "agents", "test"));
  await store.load();
  expect(
    store
      .list()
      .map((s) => s.id)
      .sort(),
  ).toEqual(["first", "second", "third"]);
  expect(children.map((c) => c.text)).toEqual([
    "調査結果",
    "調査結果",
    "調査結果",
  ]);
});
it.each(["claude", "codex"] as const)(
  "%s manages a real child runner and propagates its question without claiming completion",
  async (id) => {
    const home = await mkdtemp(join(tmpdir(), "xh-task-integration-"));
    const cwd = join(home, "project");
    await mkdir(cwd);
    const config = await loadAgentConfig(home);
    config.workflow.mode = "off";
    config.agents.explorer!.model =
      id === "claude" ? "claude:sonnet" : "codex:sol";
    const requests: ProviderRequest[] = [];
    const statuses: string[] = [];
    let round = 0;
    let taskId = "";
    const provider: Provider = {
      id,
      models: () => new FakeProvider({ provider: id }).models(),
      async *stream(req) {
        requests.push(req);
        if (req.system.startsWith("You are explorer")) {
          expect(req.tools.map((t) => t.name)).toContain("StopTask");
          expect(req.tools.map((t) => t.name)).not.toContain("TaskList");
          yield call("AskUserQuestion", {
            question: "どのファイルを調べますか？",
          });
          return;
        }
        if (++round === 1)
          yield call("Task", {
            description: "調査",
            agent: "explorer",
            prompt: "調査してください",
            background: true,
          });
        else if (round === 2) {
          const result = req.messages
            .flatMap((m) => m.content)
            .findLast((b) => b.type === "tool_result");
          if (result?.type !== "tool_result")
            throw new Error("Missing task result");
          taskId = JSON.parse(String(result.content)).taskId;
          yield call("TaskOutput", { taskId, wait: true });
        } else {
          const result = req.messages
            .flatMap((m) => m.content)
            .findLast((b) => b.type === "tool_result");
          if (result?.type !== "tool_result")
            throw new Error("Missing child output");
          expect(JSON.parse(String(result.content))).toMatchObject({
            status: "awaiting_user",
            result: "確認が必要です：どのファイルを調べますか？",
          });
          yield call("AskUserQuestion", {
            question: "どのファイルを調べますか？",
          });
        }
      },
    };
    const runtime = new WorkflowRuntime({
      home,
      cwd,
      parentId: "test",
      config,
      router: new Router([provider]),
      createTools: (cwd) => defaultTools(cwd, false),
      permission: async () => true,
      approve: async () => true,
      onStatus: (context, _model, status) => {
        if (taskId) expect(context.id).toBe(taskId);
        statuses.push(status);
      },
    });
    const result = await runtime.run(
      {
        provider,
        model: id === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol",
        system: "test",
        messages: [],
        tools: defaultTools(cwd, false),
        permission: async () => true,
      },
      new AbortController().signal,
    );
    expect(result.stopCause).toBe("awaiting_user");
    expect(statuses).toEqual(["running", "awaiting_user"]);
    expect(
      requests.filter((r) => !r.system.startsWith("You are explorer")),
    ).toHaveLength(3);
    const main = requests.filter(
      (r) => !r.system.startsWith("You are explorer"),
    );
    expect(
      main.every(
        (r) => JSON.stringify(r.tools) === JSON.stringify(main[0]!.tools),
      ),
    ).toBe(true);
  },
);

it("stops a child's pending permission when the parent ends", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-task-cancel-"));
  const cwd = join(home, "project");
  await mkdir(cwd);
  const config = await loadAgentConfig(home);
  config.workflow.mode = "off";
  let permissionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    permissionStarted = resolve;
  });
  let cancelled = false;
  let calls = 0;
  const provider: Provider = {
    id: "claude",
    models: () => new FakeProvider().models(),
    async *stream(req) {
      if (req.system.startsWith("You are explorer"))
        yield call("Read", { path: "readme.txt" });
      else if (++calls === 1)
        yield call("Task", {
          agent: "explorer",
          description: "check",
          prompt: "read",
          background: true,
        });
      else {
        await started;
        yield call("StopTask", { reason: "終了" });
      }
    },
  };
  const statuses: string[] = [];
  const runtime = new WorkflowRuntime({
    home,
    cwd,
    parentId: "test",
    config,
    router: new Router([provider]),
    createTools: (cwd) => defaultTools(cwd, false),
    approve: async () => true,
    permission: async (_ctx, _call, signal) => {
      permissionStarted();
      return new Promise<boolean>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve(false);
          },
          { once: true },
        );
      });
    },
    onStatus: (_ctx, _model, status) => {
      statuses.push(status);
    },
  });
  const result = await runtime.run(
    {
      provider,
      model: "claude-opus-5-5",
      system: "test",
      messages: [],
      tools: defaultTools(cwd, false),
      permission: async () => true,
    },
    new AbortController().signal,
  );
  expect(result.stopCause).toBe("agent_stopped");
  expect(cancelled).toBe(true);
  expect(statuses).toEqual(["running", "stopped"]);
});
