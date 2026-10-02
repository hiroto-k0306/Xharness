// MCP の HTTP サーバーの OAuth(DESIGN.md §25.7)。認可の手順(メタデータの取得・動的クライアント登録・
// PKCE・トークン交換・更新)は公式 SDK が行い、ここは保存とブラウザ・ループバックでの受け取りを担う。
// electron を import しない。暗号化した保存先(Electron の safeStorage)は main プロセスから注入する。
// トークン・クライアントの秘密を、ログ・画面・エラーメッセージに出さない(AGENTS.md)。
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type McpServerConfig } from "./config.js";

/** 暗号化して保存する場所。値は JSON の文字列 */
export interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  /** 登録した redirect_uri のポート(次回も同じポートで待つ) */
  port?: number;
}

export interface McpAuthSession {
  provider: OAuthClientProvider;
  /** ブラウザから戻った認可コードを待つ */
  waitForCode(signal: AbortSignal): Promise<string>;
  /** ループバックの待ち受けを止める */
  close(): void;
}

export interface McpOAuth {
  begin(server: McpServerConfig): Promise<McpAuthSession>;
  /** 保存したトークン・登録を消す(/mcp のログアウト) */
  logout(server: McpServerConfig): Promise<void>;
}

const DONE_PAGE =
  "<!doctype html><meta charset=utf-8><title>XHarness</title><p>認可が完了しました。XHarness に戻ってください。</p>";
const FAIL_PAGE =
  "<!doctype html><meta charset=utf-8><title>XHarness</title><p>認可できませんでした。XHarness に戻ってください。</p>";

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * @param scope 保存の鍵の前置き(ワークスペースごとの鍵)。同じ URL でもワークスペースが違えば別に保存する
 * @param openBrowser 認可の URL を既定のブラウザで開く(画面では shell.openExternal、試験では差し替え)
 */
export function createMcpOAuth(options: {
  store: SecretStore;
  scope: string;
  openBrowser(url: string): void | Promise<void>;
}): McpOAuth {
  const keyOf = (server: McpServerConfig) =>
    `mcp-oauth:${options.scope}:${server.name}:${createHash("sha256")
      .update(server.url ?? "")
      .digest("hex")
      .slice(0, 16)}`;
  const read = async (key: string): Promise<Stored> => {
    try {
      const raw = await options.store.get(key);
      const value: unknown = raw ? JSON.parse(raw) : {};
      return value && typeof value === "object" ? (value as Stored) : {};
    } catch {
      return {};
    }
  };
  return {
    async logout(server) {
      await options.store.delete(keyOf(server));
    },
    async begin(server) {
      const key = keyOf(server);
      let stored = await read(key);
      const save = async (next: Stored) => {
        stored = next;
        await options.store.set(key, JSON.stringify(next));
      };
      // 前回登録したポートで待つ(redirect_uri が変わると登録し直しになるため)。使えなければ新しいポート
      let http: Server;
      try {
        http = await listen(stored.port ?? 0);
      } catch {
        http = await listen(0);
      }
      const port = (http.address() as AddressInfo).port;
      if (stored.port !== port)
        await save({ ...stored, client: undefined, port });
      const redirectUrl = `http://127.0.0.1:${port}/callback`;
      const state = randomBytes(16).toString("hex");
      let verifier = "";
      let settle: { resolve(code: string): void; reject(e: Error): void } = {
        resolve: () => undefined,
        reject: () => undefined,
      };
      const code = new Promise<string>((resolve, reject) => {
        settle = { resolve, reject };
      });
      code.catch(() => undefined);
      http.on("request", (req, res) => {
        const url = new URL(req.url ?? "/", redirectUrl);
        if (url.pathname !== "/callback") {
          res.writeHead(404).end();
          return;
        }
        const ok =
          url.searchParams.get("state") === state &&
          !!url.searchParams.get("code");
        res
          .writeHead(ok ? 200 : 400, {
            "content-type": "text/html; charset=utf-8",
          })
          .end(ok ? DONE_PAGE : FAIL_PAGE);
        if (ok) settle.resolve(url.searchParams.get("code")!);
        // state が違う要求は別のページからの送信の可能性があるため、待ちは続ける
        else if (url.searchParams.get("state") === state)
          settle.reject(new Error("Authorization was not granted"));
      });
      const provider: OAuthClientProvider = {
        get redirectUrl() {
          return redirectUrl;
        },
        get clientMetadata() {
          return {
            client_name: "XHarness",
            redirect_uris: [redirectUrl],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
          };
        },
        state: () => state,
        clientInformation: () => stored.client,
        saveClientInformation: (client) => save({ ...stored, client }),
        tokens: () => stored.tokens,
        saveTokens: (tokens) => save({ ...stored, tokens }),
        redirectToAuthorization: (url) => options.openBrowser(url.href),
        saveCodeVerifier: (v) => {
          verifier = v;
        },
        codeVerifier: () => {
          if (!verifier) throw new Error("No code verifier");
          return verifier;
        },
        invalidateCredentials: async (scope) => {
          if (scope === "all") await save({ port });
          else if (scope === "client")
            await save({ ...stored, client: undefined });
          else if (scope === "tokens")
            await save({ ...stored, tokens: undefined });
          else if (scope === "verifier") verifier = "";
        },
      };
      return {
        provider,
        waitForCode(signal) {
          if (signal.aborted) return Promise.reject(signal.reason);
          return new Promise<string>((resolve, reject) => {
            const abort = () => reject(new Error("Authorization timed out"));
            signal.addEventListener("abort", abort, { once: true });
            code.then(
              (c) => {
                signal.removeEventListener("abort", abort);
                resolve(c);
              },
              (e: Error) => {
                signal.removeEventListener("abort", abort);
                reject(e);
              },
            );
          });
        },
        close() {
          http.close();
          http.closeAllConnections?.();
        },
      };
    },
  };
}
