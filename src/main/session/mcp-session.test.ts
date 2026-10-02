// MCP がセッションのターンで実際に使えることの結合テスト(§25)。試験用 stdio サーバーを使い、外部へ接続しない。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type UiEvent } from "../../shared/ipc.js";
import { WorkspaceTrust } from "../config/trust.js";
import { sdkConnector } from "../mcp/manager.js";
import { type Provider, type ProviderRequest } from "../providers/provider.js";
import { SessionController } from "./controller.js";

const FIXTURE = fileURLToPath(
  new URL("../../../test/fixtures/mcp/server.mjs", import.meta.url),
);

async function until(check: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 1回目は McpCall で echo を呼び、結果を受け取ったら終える */
function scripted(requests: ProviderRequest[]): Provider {
  return {
    id: "claude",
    models: () => [{ id: "fake", contextTokens: 1000000 }],
    async *stream(request) {
      requests.push(structuredClone(request));
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
                  name: "McpCall",
                  input: { server: "fx", tool: "echo", input: { text: "hi" } },
                },
              ],
        },
      };
    },
  };
}

async function setup(trusted: boolean, workflow = "off") {
  const home = await mkdtemp(join(tmpdir(), "xh-mcp-session-home-"));
  await writeFile(
    join(home, "config.yaml"),
    `workflow:\n  mode: ${workflow}\n`,
  );
  const root = await mkdtemp(join(tmpdir(), "xh-mcp-session-repo-"));
  await writeFile(
    join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: { fx: { command: process.execPath, args: [FIXTURE] } },
    }),
  );
  if (trusted) await new WorkspaceTrust(home).trust(root);
  const events: UiEvent[] = [];
  const requests: ProviderRequest[] = [];
  const make = () =>
    new SessionController({
      provider: scripted(requests),
      model: "fake",
      phase4: true,
      fake: true,
      version: "test",
      home,
      host: { pickFolder: async () => root },
      emit: (e) => events.push(e),
      mcpConnector: sdkConnector,
    });
  return { home, root, events, requests, make };
}
const asks = (events: UiEvent[]) =>
  events.filter(
    (e): e is Extract<UiEvent, { type: "permission_request" }> =>
      e.type === "permission_request",
  );
const idle = (events: UiEvent[], id: string) =>
  events.some(
    (e) => e.type === "turn" && e.sessionId === id && e.status === "idle",
  );
async function start(controller: SessionController) {
  await controller.init();
  const picked = (await controller.handle({ type: "pick_folder" })) as {
    workspaceId: string;
  };
  return (
    (await controller.handle({
      type: "new_session",
      workspaceId: picked.workspaceId,
    })) as { sessionId: string }
  ).sessionId;
}
async function answer(
  controller: SessionController,
  id: string,
  request: { requestId: string },
  decision: "allow" | "always" | "deny",
) {
  await controller.handle({
    type: "permission_response",
    sessionId: id,
    requestId: request.requestId,
    decision,
  });
}

describe("MCP in a session (§25)", () => {
  it("approves the server, asks once for the tool, and remembers both with 'always'", async () => {
    const w = await setup(true);
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({ type: "send", sessionId: id, text: "use mcp" });
    await until(() => asks(w.events).length === 1);
    const server = asks(w.events)[0]!;
    expect(server.tool).toBe("McpServer");
    expect(server.summary).toContain('"name":"fx"');
    // 承認前はモデルに送らない(サーバーも起動しない)
    expect(w.requests).toHaveLength(0);
    await answer(controller, id, server, "always");
    await until(() => asks(w.events).length === 2);
    const tool = asks(w.events)[1]!;
    expect(tool.tool).toBe("McpCall");
    await answer(controller, id, tool, "always");
    await until(() => idle(w.events, id));
    // 窓口ツールは最初の要求から最後まで同じ(§24)
    const names = w.requests.map((r) => r.tools.map((t) => t.name));
    expect(names[0]).toContain("McpSearch");
    expect(names[0]).toContain("McpCall");
    expect(names[1]).toEqual(names[0]);
    expect(JSON.stringify(w.requests[0]!.tools)).toEqual(
      JSON.stringify(w.requests[1]!.tools),
    );
    const result = w.requests[1]!.messages.at(-1)!.content.find(
      (b) => b.type === "tool_result",
    ) as { content: string; isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toMatchObject({
      kind: "external_content",
      content: "hi",
    });
    await controller.shutdown(100);

    // 次のセッション: サーバーの承認もツールの確認も出ない
    const before = asks(w.events).length;
    const again = w.make();
    const second = await start(again);
    await again.handle({ type: "send", sessionId: second, text: "again" });
    await until(() => idle(w.events, second));
    expect(asks(w.events)).toHaveLength(before);
    await again.shutdown(100);
  }, 30_000);

  it("does not start servers in an untrusted workspace but keeps the tools stable", async () => {
    const w = await setup(false);
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({ type: "send", sessionId: id, text: "use mcp" });
    await until(() => idle(w.events, id));
    expect(asks(w.events).map((a) => a.tool)).not.toContain("McpServer");
    expect(JSON.stringify(w.events)).toContain("信頼していない");
    expect(w.requests[0]!.tools.map((t) => t.name)).toContain("McpCall");
    const result = w.requests[1]!.messages.at(-1)!.content.find(
      (b) => b.type === "tool_result",
    ) as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    await controller.shutdown(100);
  }, 30_000);

  it("a denied server stays unconnected for the session and the tool call fails safely", async () => {
    const w = await setup(true);
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({ type: "send", sessionId: id, text: "use mcp" });
    await until(() => asks(w.events).length === 1);
    await answer(controller, id, asks(w.events)[0]!, "deny");
    await until(() => idle(w.events, id));
    expect(asks(w.events)).toHaveLength(1);
    const result = w.requests[1]!.messages.at(-1)!.content.find(
      (b) => b.type === "tool_result",
    ) as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    await controller.shutdown(100);
  }, 30_000);

  it("is unavailable before an approved plan in the workflow, without asking", async () => {
    const w = await setup(true, "always");
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({ type: "send", sessionId: id, text: "use mcp" });
    await until(() => asks(w.events).length === 1);
    await answer(controller, id, asks(w.events)[0]!, "allow");
    await until(() => w.requests.length >= 2);
    expect(asks(w.events).map((a) => a.tool)).toEqual(["McpServer"]);
    const result = w.requests[1]!.messages.at(-1)!.content.find(
      (b) => b.type === "tool_result",
    ) as { content: string; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable in this workflow phase");
    await controller.handle({ type: "abort", sessionId: id });
    await controller.shutdown(100);
  }, 30_000);
});
