// HTTP MCP サーバーの OAuth(§25.7)。127.0.0.1 の試験用サーバーだけを使い、外部に接続しない。
import { afterEach, describe, expect, it } from "vitest";
import { startOAuthMcpServer } from "../../../test/fixtures/mcp/http-oauth.mjs";
import { type McpServerConfig } from "./config.js";
import { McpManager } from "./manager.js";
import { createMcpOAuth, type SecretStore } from "./oauth.js";

interface Fixture {
  url: string;
  stats: { registrations: number; tokens: number };
  close(): Promise<void>;
}

function memoryStore(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k),
    set: async (k, v) => void data.set(k, v),
    delete: async (k) => void data.delete(k),
  };
}

/** ブラウザの代わり: 認可の URL を開き、リダイレクト先(ループバック)へ進む */
function fakeBrowser(opened: string[]) {
  return async (url: string) => {
    opened.push(url);
    const auth = await fetch(url, { redirect: "manual" });
    const location = auth.headers.get("location");
    if (location) await fetch(location);
  };
}

const remote = (url: string): McpServerConfig => ({
  name: "remote",
  type: "http",
  url,
  headers: {},
  hash: "h",
});
const signal = () => new AbortController().signal;

describe("MCP OAuth over Streamable HTTP", () => {
  let server: Fixture | undefined;
  const managers: McpManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
    await server?.close();
    server = undefined;
  });
  const connect = async (store: SecretStore | undefined, opened: string[]) => {
    const manager = new McpManager({
      cwd: process.cwd(),
      oauth: store
        ? createMcpOAuth({
            store,
            scope: "ws",
            openBrowser: fakeBrowser(opened),
          })
        : undefined,
    });
    managers.push(manager);
    await manager.connect([remote(server!.url)], signal());
    return manager;
  };

  it("authorizes in the browser once, then reuses the saved tokens", async () => {
    server = (await startOAuthMcpServer()) as Fixture;
    const store = memoryStore();
    const opened: string[] = [];
    const first = await connect(store, opened);
    expect(first.states()[0]).toMatchObject({
      name: "remote",
      status: "connected",
      tools: 1,
    });
    expect(opened).toHaveLength(1);
    // PKCE と state を付けて、ループバックへ戻す
    const url = new URL(opened[0]!);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/callback$/,
    );
    expect(await first.call("remote", "whoami", {}, signal())).toEqual({
      text: "client:ok",
      isError: false,
    });
    expect(server.stats).toEqual({ registrations: 1, tokens: 1 });
    // 保存した内容にトークンがある(保存先は暗号化ストレージ。ここでは平文のメモリ)
    const saved = JSON.parse([...store.data.values()][0]!);
    expect(saved.tokens.access_token).toBeTruthy();
    // 状態・エラーにトークンを出さない
    expect(JSON.stringify(first.states())).not.toContain(
      saved.tokens.access_token,
    );

    const second = await connect(store, opened);
    expect(second.states()[0]!.status).toBe("connected");
    expect(opened).toHaveLength(1);
    expect(server.stats).toEqual({ registrations: 1, tokens: 1 });
  }, 30_000);

  it("is 'needs_auth' without a secret store (headless) and logout forgets the tokens", async () => {
    server = (await startOAuthMcpServer()) as Fixture;
    const headless = await connect(undefined, []);
    expect(headless.states()[0]!.status).toBe("needs_auth");
    expect(headless.servers()).toEqual([]);

    const store = memoryStore();
    const opened: string[] = [];
    await connect(store, opened);
    const oauth = createMcpOAuth({
      store,
      scope: "ws",
      openBrowser: fakeBrowser(opened),
    });
    await oauth.logout(remote(server.url));
    expect(store.data.size).toBe(0);
    await connect(store, opened);
    expect(opened).toHaveLength(2);
  }, 30_000);

  it("ignores a callback with a wrong state and keeps waiting", async () => {
    const store = memoryStore();
    const oauth = createMcpOAuth({ store, scope: "ws", openBrowser: () => {} });
    const session = await oauth.begin(remote("http://127.0.0.1:9/mcp"));
    try {
      const redirect = String(session.provider.redirectUrl);
      const state = await session.provider.state!();
      const wrong = await fetch(`${redirect}?code=evil&state=nope`);
      expect(wrong.status).toBe(400);
      const waiting = session.waitForCode(AbortSignal.timeout(5000));
      const ok = await fetch(`${redirect}?code=good&state=${state}`);
      expect(ok.status).toBe(200);
      expect(await waiting).toBe("good");
    } finally {
      session.close();
    }
  });
});

describe("encrypted secret file", () => {
  it("stores only cipher text and treats undecryptable values as missing", async () => {
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileSecretStore } = await import("./secret-file.js");
    const dir = await mkdtemp(join(tmpdir(), "xh-secret-"));
    const xor = (b: Buffer) => Buffer.from(b.map((x) => x ^ 0x5a));
    let broken = false;
    const store = fileSecretStore(dir, {
      encrypt: (t) => xor(Buffer.from(t, "utf8")),
      decrypt: (b) => {
        if (broken) throw new Error("cannot decrypt");
        return xor(b).toString("utf8");
      },
    });
    await store.set("k", '{"tokens":{"access_token":"plain-token-value"}}');
    expect(await store.get("k")).toContain("plain-token-value");
    expect(await readFile(join(dir, "mcp-oauth.json"), "utf8")).not.toContain(
      "plain-token-value",
    );
    broken = true;
    expect(await store.get("k")).toBeUndefined();
    await store.delete("k");
    broken = false;
    expect(await store.get("k")).toBeUndefined();
  });
});

describe("OAuth storage hygiene", () => {
  it("writes nothing for a server that never needs authorization", async () => {
    const data = new Map<string, string>();
    const oauth = createMcpOAuth({
      store: {
        get: async (k) => data.get(k),
        set: async (k, v) => void data.set(k, v),
        delete: async (k) => void data.delete(k),
      },
      scope: "ws",
      openBrowser: () => {},
    });
    const session = await oauth.begin(remote("http://127.0.0.1:9/mcp"));
    session.close();
    expect(data.size).toBe(0);
  });
});
