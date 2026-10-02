// ワークスペースの信頼確認が、セッションのターンで実際に効くことの結合テスト。
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type UiEvent } from "../../shared/ipc.js";
import { type Provider } from "../providers/provider.js";
import { type Tool } from "../tools/registry.js";
import { SessionController } from "./controller.js";

async function until(check: () => boolean) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 1回目は Bash の git status を呼び、結果を受け取ったら終える */
const provider: Provider = {
  id: "claude",
  models: () => [{ id: "fake", contextTokens: 1000000 }],
  async *stream(request) {
    const done = request.messages
      .at(-1)
      ?.content.some((b) => b.type === "tool_result");
    yield {
      type: "message_done",
      stopReason: done ? "end_turn" : "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
      message: {
        role: "assistant",
        content: done
          ? [{ type: "text", text: "done" }]
          : [
              {
                type: "tool_use",
                id: `call-${request.messages.length}`,
                name: "Bash",
                input: { command: "git status" },
              },
            ],
      },
    };
  },
};

async function workspace() {
  const home = await mkdtemp(join(tmpdir(), "xh-trust-home-"));
  const root = await mkdtemp(join(tmpdir(), "xh-trust-repo-"));
  await mkdir(join(root, ".xharness"));
  await writeFile(
    join(root, ".xharness", "config.yaml"),
    "permissions:\n  rules: [{tool: Bash, decision: allow}]\n",
  );
  let ran = 0;
  const tool: Tool = {
    spec: { name: "Bash", description: "test", inputSchema: {} },
    readOnly: false,
    validate: async () => undefined,
    execute: async () => {
      ran++;
      return { content: "ok" };
    },
  };
  const events: UiEvent[] = [];
  const make = () =>
    new SessionController({
      provider,
      model: "fake",
      phase4: true,
      fake: true,
      version: "test",
      home,
      host: { pickFolder: async () => root },
      createTools: () => new Map([["Bash", tool]]),
      emit: (e) => events.push(e),
    });
  return { home, root, events, make, ran: () => ran };
}
const requests = (events: UiEvent[]) =>
  events.filter(
    (e): e is Extract<UiEvent, { type: "permission_request" }> =>
      e.type === "permission_request",
  );
async function start(controller: SessionController) {
  await controller.init();
  const picked = (await controller.handle({ type: "pick_folder" })) as {
    workspaceId: string;
  };
  const created = (await controller.handle({
    type: "new_session",
    workspaceId: picked.workspaceId,
  })) as { sessionId: string };
  return created.sessionId;
}
const idle = (events: UiEvent[], id: string, count = 1) =>
  events.filter(
    (e) => e.type === "turn" && e.sessionId === id && e.status === "idle",
  ).length >= count;

describe("workspace trust for project settings", () => {
  it("asks before applying a cloned repository's allow rules; declining keeps asking per tool", async () => {
    const w = await workspace();
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({ type: "send", sessionId: id, text: "test it" });
    await until(() => requests(w.events).length === 1);
    const trust = requests(w.events)[0]!;
    expect(trust.tool).toBe("ProjectSettings");
    expect(trust.summary).toContain('"decision":"allow"');
    // 信頼の確認より前にツールは動かない
    expect(w.ran()).toBe(0);
    await controller.handle({
      type: "permission_response",
      sessionId: id,
      requestId: trust.requestId,
      decision: "deny",
    });
    // 許可ルールは適用されないので、Bash は個別に確認される
    await until(() => requests(w.events).length === 2);
    expect(requests(w.events)[1]!.tool).toBe("Bash");
    await controller.handle({
      type: "permission_response",
      sessionId: id,
      requestId: requests(w.events)[1]!.requestId,
      decision: "deny",
    });
    await until(() => idle(w.events, id));
    expect(w.ran()).toBe(0);
    expect(JSON.stringify(w.events)).toContain("適用せずに続けます");
  });

  it("'always' trusts the workspace: rules apply now and in later sessions without asking again", async () => {
    const w = await workspace();
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({ type: "send", sessionId: id, text: "test it" });
    await until(() => requests(w.events).length === 1);
    await controller.handle({
      type: "permission_response",
      sessionId: id,
      requestId: requests(w.events)[0]!.requestId,
      decision: "always",
    });
    await until(() => idle(w.events, id));
    expect(w.ran()).toBe(1);
    expect(requests(w.events)).toHaveLength(1);
    await controller.shutdown();
    w.events.length = 0;
    const again = w.make();
    const second = await start(again);
    await again.handle({ type: "send", sessionId: second, text: "test again" });
    await until(() => idle(w.events, second));
    expect(requests(w.events)).toHaveLength(0);
    expect(w.ran()).toBe(2);
  });

  it("does not prompt when the project settings only restrict", async () => {
    const w = await workspace();
    await writeFile(
      join(w.root, ".xharness", "config.yaml"),
      "permissions:\n  rules: [{tool: Read, decision: deny}]\n",
    );
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({ type: "send", sessionId: id, text: "test it" });
    await until(() => requests(w.events).length === 1);
    expect(requests(w.events)[0]!.tool).toBe("Bash");
    await controller.handle({ type: "abort", sessionId: id });
    await until(() => idle(w.events, id));
  });
});
