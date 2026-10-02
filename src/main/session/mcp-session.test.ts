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
      const last = request.messages.at(-1)!;
      const said = last.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join(" ");
      // "use mcp" のときだけ McpCall を呼ぶ("toggle" なら一覧を変えるツール)。それ以外はすぐ終える
      const done =
        last.content.some((b) => b.type === "tool_result") ||
        !/use mcp|toggle/.test(said);
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
                  input: said.includes("toggle")
                    ? { server: "fx", tool: "toggle" }
                    : { server: "fx", tool: "echo", input: { text: "hi" } },
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

  it("tells the model about changed MCP tools in the next user message, without changing tools", async () => {
    const w = await setup(true);
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({ type: "send", sessionId: id, text: "toggle" });
    await until(() => asks(w.events).length === 1);
    await answer(controller, id, asks(w.events)[0]!, "allow");
    await until(() => asks(w.events).length === 2);
    await answer(controller, id, asks(w.events)[1]!, "allow");
    await until(() => idle(w.events, id));
    await new Promise((r) => setTimeout(r, 300));
    const before = w.events.filter((e) => e.type === "turn").length;
    await controller.handle({ type: "send", sessionId: id, text: "next" });
    await until(
      () =>
        w.events.filter(
          (e) => e.type === "turn" && e.sessionId === id && e.status === "idle",
        ).length >= 2 &&
        w.events.filter((e) => e.type === "turn").length > before,
    );
    const last = w.requests.at(-1)!;
    const user = last.messages.at(-1)!;
    expect(user.content).toHaveLength(2);
    expect((user.content[1] as { text: string }).text).toContain(
      "[MCP update]",
    );
    expect((user.content[1] as { text: string }).text).toContain(
      "fx tools: added extra",
    );
    // tools は最初の要求から変わらない
    expect(JSON.stringify(last.tools)).toBe(
      JSON.stringify(w.requests[0]!.tools),
    );
    // 画面の発言には注記を出さない
    const said = w.events.filter(
      (e): e is Extract<UiEvent, { type: "user_message" }> =>
        e.type === "user_message",
    );
    expect(said.at(-1)!.text).toBe("next");
    await controller.shutdown(100);
  }, 30_000);

  it("expands an MCP prompt after showing it, and sends it as the user's message", async () => {
    const w = await setup(true);
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({
      type: "send",
      sessionId: id,
      text: "/mcp__fx__review src/a.ts error handling",
    });
    await until(() => asks(w.events).length === 1);
    await answer(controller, id, asks(w.events)[0]!, "allow");
    await until(() => asks(w.events).length === 2);
    const preview = asks(w.events)[1]!;
    expect(preview.tool).toBe("McpPrompt");
    expect(preview.summary).toContain(
      "Review src/a.ts focusing on error handling",
    );
    // 確認の前にはモデルへ送らない
    expect(w.requests).toHaveLength(0);
    await answer(controller, id, preview, "allow");
    await until(() => idle(w.events, id));
    const first = w.requests[0]!.messages[0]!;
    expect((first.content[0] as { text: string }).text).toBe(
      "Review src/a.ts focusing on error handling",
    );
    // 必須の引数が無ければ送らずに知らせる
    const sent = w.requests.length;
    await controller.handle({
      type: "send",
      sessionId: id,
      text: "/mcp__fx__review",
    });
    await until(() => JSON.stringify(w.events).includes("必須の引数"));
    expect(w.requests).toHaveLength(sent);
    await controller.shutdown(100);
  }, 30_000);
});

describe("MCP OAuth in a session (§25.7)", () => {
  it("opens the browser for authorization, then the tool works; tokens never reach the UI", async () => {
    const { startOAuthMcpServer } =
      await import("../../../test/fixtures/mcp/http-oauth.mjs");
    const server = (await startOAuthMcpServer()) as {
      url: string;
      close(): Promise<void>;
    };
    const home = await mkdtemp(join(tmpdir(), "xh-mcp-oauth-home-"));
    const root = await mkdtemp(join(tmpdir(), "xh-mcp-oauth-repo-"));
    await writeFile(join(home, "config.yaml"), "workflow:\n  mode: off\n");
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { remote: { type: "http", url: server.url } },
      }),
    );
    await new WorkspaceTrust(home).trust(root);
    const secrets = new Map<string, string>();
    const opened: string[] = [];
    const events: UiEvent[] = [];
    const requests: ProviderRequest[] = [];
    const provider: Provider = {
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
                    id: "c1",
                    name: "McpCall",
                    input: { server: "remote", tool: "whoami" },
                  },
                ],
          },
        };
      },
    };
    const controller = new SessionController({
      provider,
      model: "fake",
      phase4: true,
      fake: true,
      version: "test",
      home,
      host: { pickFolder: async () => root },
      emit: (e) => events.push(e),
      mcpConnector: sdkConnector,
      mcpSecrets: {
        get: async (k) => secrets.get(k),
        set: async (k, v) => void secrets.set(k, v),
        delete: async (k) => void secrets.delete(k),
      },
      openExternal: (url) => {
        opened.push(url);
        void (async () => {
          const auth = await fetch(url, { redirect: "manual" });
          await fetch(auth.headers.get("location")!);
        })();
      },
    });
    try {
      const id = await start(controller);
      await controller.handle({ type: "send", sessionId: id, text: "use mcp" });
      await until(() => asks(events).length === 1);
      await answer(controller, id, asks(events)[0]!, "allow");
      await until(() => asks(events).length === 2);
      await answer(controller, id, asks(events)[1]!, "allow");
      await until(() => idle(events, id));
      expect(opened).toHaveLength(1);
      expect(JSON.stringify(events)).toContain("ブラウザで");
      const result = requests[1]!.messages
        .at(-1)!
        .content.find((b) => b.type === "tool_result") as { content: string };
      expect(JSON.parse(result.content).content).toBe("client:ok");
      const token = JSON.parse([...secrets.values()][0]!).tokens.access_token;
      expect(token).toBeTruthy();
      expect(JSON.stringify(events)).not.toContain(token);
      expect(JSON.stringify(requests)).not.toContain(token);
      // /mcp logout で保存したトークンを消し、切断する(状態の表示にもトークンを出さない)
      await controller.handle({
        type: "send",
        sessionId: id,
        text: "/mcp logout remote",
      });
      await until(() => JSON.stringify(events).includes("ログアウトしました"));
      expect(secrets.size).toBe(0);
      const last = events
        .filter((e): e is Extract<UiEvent, { type: "mcp" }> => e.type === "mcp")
        .at(-1)!;
      expect(last.servers[0]).toMatchObject({
        name: "remote",
        status: "needs_auth",
        oauth: true,
      });
      expect(JSON.stringify(events)).not.toContain(token);
    } finally {
      await controller.shutdown(100);
      await server.close();
    }
  }, 30_000);

  it("only opens https or loopback http authorization URLs", async () => {
    const { isAuthorizationUrl } = await import("./mcp-session.js");
    expect(isAuthorizationUrl("https://auth.example.com/authorize")).toBe(true);
    expect(isAuthorizationUrl("http://127.0.0.1:3000/authorize")).toBe(true);
    expect(isAuthorizationUrl("http://evil.example.com/authorize")).toBe(false);
    expect(isAuthorizationUrl("file:///C:/x")).toBe(false);
    expect(isAuthorizationUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("/mcp command (§25.8)", () => {
  const mcpEvents = (events: UiEvent[]) =>
    events.filter(
      (e): e is Extract<UiEvent, { type: "mcp" }> => e.type === "mcp",
    );
  const turns = (events: UiEvent[], id: string) =>
    events.filter(
      (e) => e.type === "turn" && e.sessionId === id && e.status === "idle",
    ).length;
  it("shows the state without calling the model, and reset / reconnect / deny change it", async () => {
    const w = await setup(true);
    const controller = w.make();
    const id = await start(controller);
    // 最初の /mcp で準備する(承認を尋ねる)。モデルには送らない
    await controller.handle({ type: "send", sessionId: id, text: "/mcp" });
    await until(() => asks(w.events).length === 1);
    await answer(controller, id, asks(w.events)[0]!, "always");
    await until(() => mcpEvents(w.events).some((e) => e.show));
    const shown = mcpEvents(w.events).find((e) => e.show)!;
    expect(shown.servers).toEqual([
      expect.objectContaining({ name: "fx", status: "connected", tools: 6 }),
    ]);
    expect(shown.prompts[0]).toEqual({
      command: "/mcp__fx__review",
      description: "Ask for a code review",
      arguments: [
        { name: "file", required: true },
        { name: "focus", required: false },
      ],
    });
    await until(() => turns(w.events, id) >= 1);
    expect(w.requests).toHaveLength(0);

    // 承認を取り消すと切断し、次の発言でモデルに「消えた」ことを伝える
    await controller.handle({
      type: "send",
      sessionId: id,
      text: "/mcp reset fx",
    });
    await until(() => turns(w.events, id) >= 2);
    expect(mcpEvents(w.events).at(-1)!.servers[0]!.status).toBe("unapproved");
    await controller.handle({ type: "send", sessionId: id, text: "hello" });
    await until(() => turns(w.events, id) >= 3);
    const hello = w.requests
      .at(-1)!
      .messages.find(
        (m) => (m.content[0] as { text?: string }).text === "hello",
      )!;
    const note = (hello.content[1] as { text: string }).text;
    expect(note).toContain("fx tools: removed");

    // 接続し直すときは承認を尋ね直す。拒否は保存され、次のセッションでも尋ねない
    await controller.handle({
      type: "send",
      sessionId: id,
      text: "/mcp reconnect fx",
    });
    await until(() => asks(w.events).length === 2);
    await answer(controller, id, asks(w.events)[1]!, "deny");
    await until(() => turns(w.events, id) >= 4);
    expect(mcpEvents(w.events).at(-1)!.servers[0]!.status).toBe("rejected");
    await controller.shutdown(100);
    const again = w.make();
    const second = await start(again);
    await again.handle({ type: "send", sessionId: second, text: "/mcp" });
    await until(
      () =>
        mcpEvents(w.events).filter((e) => e.sessionId === second && e.show)
          .length > 0,
    );
    expect(asks(w.events)).toHaveLength(2);
    expect(
      mcpEvents(w.events)
        .filter((e) => e.sessionId === second)
        .at(-1)!.servers[0]!.status,
    ).toBe("rejected");
    // reconnect で承認し直せる
    await again.handle({
      type: "send",
      sessionId: second,
      text: "/mcp reconnect fx",
    });
    await until(() => asks(w.events).length === 3);
    await answer(again, second, asks(w.events)[2]!, "allow");
    await until(
      () =>
        mcpEvents(w.events)
          .filter((e) => e.sessionId === second)
          .at(-1)!.servers[0]!.status === "connected",
    );
    await again.shutdown(100);
  }, 30_000);

  it("rejects bad usage and operations on unknown servers", async () => {
    const w = await setup(true);
    const controller = w.make();
    const id = await start(controller);
    await controller.handle({
      type: "send",
      sessionId: id,
      text: "/mcp nope fx",
    });
    await until(() => JSON.stringify(w.events).includes("使い方: /mcp"));
    await until(() => turns(w.events, id) >= 1);
    await controller.handle({
      type: "send",
      sessionId: id,
      text: "/mcp reset other",
    });
    // 書式が正しければ MCP を準備する(fx の承認を尋ねる)
    await until(() => asks(w.events).length === 1);
    await answer(controller, id, asks(w.events)[0]!, "allow");
    await until(() =>
      JSON.stringify(w.events).includes("other は .mcp.json にありません"),
    );
    expect(w.requests).toHaveLength(0);
    await controller.shutdown(100);
  }, 30_000);
});
