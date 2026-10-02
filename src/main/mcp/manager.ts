// MCP サーバーへの接続と呼び出し(DESIGN.md §25)。公式 TypeScript SDK を使う。
// electron を import しない。OAuth のトークンは McpOAuth(§25.7)が扱い、ここでは保持しない。
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type McpServerConfig } from "./config.js";
import { type McpOAuth } from "./oauth.js";

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface McpResourceInfo {
  server: string;
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}
export interface McpPromptInfo {
  server: string;
  name: string;
  description?: string;
  arguments: { name: string; description?: string; required?: boolean }[];
}
export type McpListKind = "tools" | "resources" | "prompts";

export type McpStatus =
  "connected" | "failed" | "unapproved" | "rejected" | "needs_auth";

export interface McpServerState {
  name: string;
  type: McpServerConfig["type"];
  status: McpStatus;
  tools: number;
  resources?: number;
  prompts?: number;
  error?: string;
}

/** callTool の結果(MCP の CallToolResult のうち使う部分) */
export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

type Without<T> = Omit<T, "server">;

/** 1つのサーバーとの接続。試験では差し替える */
export interface McpConnection {
  /** サーバーが対応している一覧(initialize の capabilities) */
  supports: Record<McpListKind, boolean>;
  listTools(signal: AbortSignal): Promise<Without<McpToolInfo>[]>;
  listResources(signal: AbortSignal): Promise<Without<McpResourceInfo>[]>;
  listPrompts(signal: AbortSignal): Promise<Without<McpPromptInfo>[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<McpCallResult>;
  readResource(uri: string, signal: AbortSignal): Promise<unknown[]>;
  getPrompt(
    name: string,
    args: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown[]>;
  close(): Promise<void>;
}

export type McpConnector = (
  server: McpServerConfig,
  options: {
    cwd: string;
    onStderr(text: string): void;
    onListChanged(kind: McpListKind): void;
    /** 起動・初期化の上限(承認やブラウザでの認可の待ち時間は含めない) */
    signal: AbortSignal;
    /** セッションの中断(ブラウザでの認可を待つ間に使う) */
    outer: AbortSignal;
    oauth?: McpOAuth;
  },
) => Promise<McpConnection>;

export const MCP_CLIENT_INFO = { name: "xharness", version: "0.0.0" };
/** ブラウザでの認可を待つ上限 */
const AUTH_WAIT_MS = 5 * 60_000;

async function pages<T, R>(
  fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
  map: (item: T) => R,
): Promise<R[]> {
  const all: R[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await fetch(cursor);
    all.push(...result.items.map(map));
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return all;
}

/** 公式 SDK による接続(stdio / Streamable HTTP、HTTP は必要なら OAuth) */
export const sdkConnector: McpConnector = async (server, options) => {
  let pid: number | null = null;
  const killTree = () => {
    // Windows では npx などが孫プロセスを作るため、プロセスツリーごと止める
    if (process.platform === "win32" && pid)
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  };
  const newClient = () => {
    const client = new Client(MCP_CLIENT_INFO, { capabilities: {} });
    client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
      options.onListChanged("tools"),
    );
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () =>
      options.onListChanged("resources"),
    );
    client.setNotificationHandler(PromptListChangedNotificationSchema, () =>
      options.onListChanged("prompts"),
    );
    return client;
  };
  let client = newClient();
  if (server.type === "stdio") {
    const transport = new StdioClientTransport({
      command: server.command!,
      args: server.args,
      // SDK の既定(PATH など最小限の変数)に .mcp.json の env を足す。親の環境変数をすべては渡さない
      env: server.env,
      cwd: options.cwd,
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) =>
      options.onStderr(chunk.toString("utf8")),
    );
    try {
      await client.connect(transport, { signal: options.signal });
    } catch (error) {
      // 初期化の失敗・時間切れでも、起動したプロセスを残さない
      pid = transport.pid;
      killTree();
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    }
    pid = transport.pid;
  } else {
    const auth = await options.oauth?.begin(server);
    const transport = () =>
      new StreamableHTTPClientTransport(new URL(server.url!), {
        requestInit: { headers: server.headers },
        ...(auth ? { authProvider: auth.provider } : {}),
      });
    try {
      const first = transport();
      try {
        await client.connect(first, { signal: options.signal });
      } catch (error) {
        if (!auth || !(error instanceof UnauthorizedError)) throw error;
        // SDK が認可の URL をブラウザで開いた。戻ってくる認可コードを待ち、トークンに換える
        const code = await auth.waitForCode(
          AbortSignal.any([options.outer, AbortSignal.timeout(AUTH_WAIT_MS)]),
        );
        await first.finishAuth(code);
        await client.close().catch(() => undefined);
        client = newClient();
        await client.connect(transport(), {
          signal: AbortSignal.any([options.outer, AbortSignal.timeout(60_000)]),
        });
      }
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    } finally {
      auth?.close();
    }
  }
  const capabilities = client.getServerCapabilities() ?? {};
  return {
    supports: {
      tools: !!capabilities.tools,
      resources: !!capabilities.resources,
      prompts: !!capabilities.prompts,
    },
    listTools: (signal) =>
      pages(
        async (cursor) => {
          const r = await client.listTools(cursor ? { cursor } : {}, {
            signal,
          });
          return { items: r.tools, nextCursor: r.nextCursor };
        },
        (t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema as Record<string, unknown>,
        }),
      ),
    listResources: (signal) =>
      pages(
        async (cursor) => {
          const r = await client.listResources(cursor ? { cursor } : {}, {
            signal,
          });
          return { items: r.resources, nextCursor: r.nextCursor };
        },
        (r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        }),
      ),
    listPrompts: (signal) =>
      pages(
        async (cursor) => {
          const r = await client.listPrompts(cursor ? { cursor } : {}, {
            signal,
          });
          return { items: r.prompts, nextCursor: r.nextCursor };
        },
        (p) => ({
          name: p.name,
          description: p.description,
          arguments: (p.arguments ?? []).map((a) => ({
            name: a.name,
            description: a.description,
            required: a.required,
          })),
        }),
      ),
    async callTool(name, args, signal, timeoutMs) {
      return (await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: timeoutMs,
      })) as McpCallResult;
    },
    async readResource(uri, signal) {
      return (await client.readResource({ uri }, { signal })).contents;
    },
    async getPrompt(name, args, signal) {
      return (await client.getPrompt({ name, arguments: args }, { signal }))
        .messages;
    },
    async close() {
      killTree();
      await client.close().catch(() => undefined);
    },
  };
};

/** 結果を文字列にする。text と埋め込みテキストリソースだけを渡し、それ以外は種類だけ書く(§25.4) */
export function formatCallResult(result: McpCallResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    const c = item as Record<string, unknown>;
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "resource") {
      const r = c.resource as Record<string, unknown> | undefined;
      if (r && typeof r.text === "string")
        parts.push(`[resource ${String(r.uri)}]\n${r.text}`);
      else
        parts.push(`[unsupported content: binary resource ${String(r?.uri)}]`);
    } else if (c.type === "resource_link")
      parts.push(`[resource link ${String(c.uri)}]`);
    else parts.push(`[unsupported content: ${String(c.type)}]`);
  }
  if (!parts.length && result.structuredContent !== undefined)
    parts.push(JSON.stringify(result.structuredContent));
  return parts.join("\n");
}

/** resources/read の contents を文字列にする(テキストだけ。バイナリは種類だけ書く) */
export function formatResourceContents(contents: unknown[]): string {
  return contents
    .map((item) => {
      const c = item as Record<string, unknown>;
      return typeof c.text === "string"
        ? contents.length > 1
          ? `[resource ${String(c.uri)}]\n${c.text}`
          : c.text
        : `[unsupported content: binary resource ${String(c.uri)}${c.mimeType ? ` (${String(c.mimeType)})` : ""}]`;
    })
    .join("\n");
}

/** prompts/get の messages を、ユーザーの入力にする文字列へ(text だけ。§25.6) */
export function formatPromptMessages(messages: unknown[]): string {
  return messages
    .map((item) => {
      const m = item as { role?: string; content?: Record<string, unknown> };
      const c = m.content ?? {};
      const text =
        c.type === "text" && typeof c.text === "string"
          ? c.text
          : c.type === "resource" &&
              typeof (c.resource as { text?: unknown })?.text === "string"
            ? String((c.resource as { text: string }).text)
            : `[unsupported content: ${String(c.type)}]`;
      return m.role === "assistant" ? `(assistant) ${text}` : text;
    })
    .join("\n\n");
}

/** 一覧の変化(次の user メッセージに注記する。§25.4) */
export interface McpListChange {
  server: string;
  kind: "tools" | "resources";
  added: string[];
  removed: string[];
}

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private toolList: McpToolInfo[] = [];
  private resourceList: McpResourceInfo[] = [];
  private promptList: McpPromptInfo[] = [];
  private readonly state = new Map<string, McpServerState>();
  private readonly stderr = new Map<string, string>();
  private changes: McpListChange[] = [];
  private refreshing = new Map<string, Promise<void>>();
  private closed = false;

  constructor(
    private readonly options: {
      cwd: string;
      connector?: McpConnector;
      startupTimeoutMs?: number;
      toolTimeoutMs?: number;
      redact?(text: string): string;
      /** サーバーの stderr(マスク済み)。ログファイルへ書く */
      log?(server: string, text: string): void;
      /** HTTP サーバーの OAuth(§25.7)。無ければ認可が必要なサーバーは needs_auth */
      oauth?: McpOAuth;
      /** 一覧が変わった(画面の補完などの更新用) */
      onChange?(change: { server: string; kind: McpListKind }): void;
    },
  ) {}

  /** 承認しなかったサーバーを状態に載せる(/mcp の表示用) */
  skip(server: McpServerConfig, status: "unapproved" | "rejected") {
    this.state.set(server.name, {
      name: server.name,
      type: server.type,
      status,
      tools: 0,
    });
  }

  /** 承認済みのサーバーへ並行して接続する。失敗したサーバーは使えない状態にして続ける */
  async connect(servers: McpServerConfig[], signal: AbortSignal) {
    await Promise.all(servers.map((s) => this.connectOne(s, signal)));
    this.sort();
  }

  /** 名前の順にそろえる(説明文や一覧が接続の速さで変わらないように) */
  private sort() {
    const key = (a: { server: string }, b: string) => `${a.server}\0${b}`;
    this.toolList.sort((a, b) => key(a, a.name).localeCompare(key(b, b.name)));
    this.resourceList.sort((a, b) =>
      key(a, a.uri).localeCompare(key(b, b.uri)),
    );
    this.promptList.sort((a, b) =>
      key(a, a.name).localeCompare(key(b, b.name)),
    );
  }

  private async load(
    server: string,
    connection: McpConnection,
    kind: McpListKind,
    signal: AbortSignal,
  ) {
    if (!connection.supports[kind]) return [];
    if (kind === "tools") return connection.listTools(signal);
    if (kind === "resources") return connection.listResources(signal);
    return connection.listPrompts(signal);
  }

  private async connectOne(server: McpServerConfig, outer: AbortSignal) {
    const clean = this.options.redact ?? ((s: string) => s);
    const timeout = AbortSignal.timeout(
      this.options.startupTimeoutMs ?? 30_000,
    );
    const signal = AbortSignal.any([outer, timeout]);
    let connection: McpConnection | undefined;
    try {
      connection = await (this.options.connector ?? sdkConnector)(server, {
        cwd: this.options.cwd,
        signal,
        outer,
        oauth: this.options.oauth,
        onListChanged: (kind) => void this.refresh(server.name, kind),
        onStderr: (text) => {
          const masked = clean(text);
          this.stderr.set(
            server.name,
            ((this.stderr.get(server.name) ?? "") + masked).slice(-2000),
          );
          this.options.log?.(server.name, masked);
        },
      });
      // 認可を待った場合は起動の上限を過ぎていることがある。一覧の取得には新しい上限を使う
      const listSignal = AbortSignal.any([
        outer,
        AbortSignal.timeout(this.options.startupTimeoutMs ?? 30_000),
      ]);
      const tools = (await this.load(
        server.name,
        connection,
        "tools",
        listSignal,
      )) as Without<McpToolInfo>[];
      const resources = (await this.load(
        server.name,
        connection,
        "resources",
        listSignal,
      )) as Without<McpResourceInfo>[];
      const prompts = (await this.load(
        server.name,
        connection,
        "prompts",
        listSignal,
      )) as Without<McpPromptInfo>[];
      if (this.closed) throw new Error("closed");
      this.connections.set(server.name, connection);
      const s = { server: server.name };
      this.toolList.push(...tools.map((t) => ({ ...t, ...s })));
      this.resourceList.push(...resources.map((r) => ({ ...r, ...s })));
      this.promptList.push(...prompts.map((p) => ({ ...p, ...s })));
      this.state.set(server.name, {
        name: server.name,
        type: server.type,
        status: "connected",
        tools: tools.length,
        resources: resources.length,
        prompts: prompts.length,
      });
    } catch (error) {
      await connection?.close().catch(() => undefined);
      const message =
        timeout.aborted && !outer.aborted && !connection
          ? "起動・初期化が時間内に終わりませんでした"
          : error instanceof Error
            ? error.message
            : "接続できませんでした";
      const unauthorized =
        error instanceof UnauthorizedError ||
        /\b401\b|unauthori[sz]ed/i.test(message);
      this.state.set(server.name, {
        name: server.name,
        type: server.type,
        status: unauthorized ? "needs_auth" : "failed",
        tools: 0,
        error: clean(message).slice(0, 300),
      });
    }
  }

  /** list_changed を受けたら、その一覧を取り直す(同じサーバー・種類は順番に) */
  refresh(server: string, kind: McpListKind): Promise<void> {
    const key = `${server}\0${kind}`;
    const run = (this.refreshing.get(key) ?? Promise.resolve()).then(() =>
      this.refreshNow(server, kind).catch(() => undefined),
    );
    this.refreshing.set(key, run);
    return run;
  }

  private async refreshNow(server: string, kind: McpListKind) {
    const connection = this.connections.get(server);
    if (!connection || this.closed) return;
    const items = await this.load(
      server,
      connection,
      kind,
      AbortSignal.timeout(this.options.startupTimeoutMs ?? 30_000),
    );
    if (this.closed || this.connections.get(server) !== connection) return;
    const id = (x: { name: string; uri?: string }) =>
      kind === "resources" ? x.uri! : x.name;
    const before = (
      kind === "tools"
        ? this.toolList
        : kind === "resources"
          ? this.resourceList
          : this.promptList
    ).filter((x) => x.server === server);
    const next = (items as { name: string; uri?: string }[]).map((x) => ({
      ...x,
      server,
    }));
    const old = new Set(before.map(id));
    const now = new Set(next.map(id));
    if (kind === "tools")
      this.toolList = [
        ...this.toolList.filter((t) => t.server !== server),
        ...(next as McpToolInfo[]),
      ];
    else if (kind === "resources")
      this.resourceList = [
        ...this.resourceList.filter((r) => r.server !== server),
        ...(next as unknown as McpResourceInfo[]),
      ];
    else
      this.promptList = [
        ...this.promptList.filter((p) => p.server !== server),
        ...(next as unknown as McpPromptInfo[]),
      ];
    this.sort();
    const state = this.state.get(server);
    if (state) state[kind] = next.length;
    const added = [...now].filter((x) => !old.has(x));
    const removed = [...old].filter((x) => !now.has(x));
    if (kind !== "prompts" && (added.length || removed.length))
      this.changes.push({ server, kind, added, removed });
    this.options.onChange?.({ server, kind });
  }

  /** まだ会話に伝えていない一覧の変化を取り出す */
  takeChanges(): McpListChange[] {
    const all = this.changes;
    this.changes = [];
    return all;
  }

  states(): McpServerState[] {
    return [...this.state.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
  tools(): McpToolInfo[] {
    return [...this.toolList];
  }
  resources(): McpResourceInfo[] {
    return [...this.resourceList];
  }
  prompts(): McpPromptInfo[] {
    return [...this.promptList];
  }
  /** 接続しているサーバーの名前 */
  servers(): string[] {
    return this.states()
      .filter((s) => s.status === "connected")
      .map((s) => s.name);
  }
  find(server: string, tool: string): McpToolInfo | undefined {
    return this.toolList.find((t) => t.server === server && t.name === tool);
  }
  findPrompt(server: string, name: string): McpPromptInfo | undefined {
    return this.promptList.find((p) => p.server === server && p.name === name);
  }
  /** 最後の stderr(マスク済み)。失敗の通知に添える */
  lastError(server: string): string | undefined {
    return this.stderr.get(server);
  }

  async call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    const connection = this.connections.get(server);
    if (!connection || !this.find(server, tool))
      return {
        text: `MCP tool ${server}/${tool} is not available`,
        isError: true,
      };
    const result = await connection.callTool(
      tool,
      args,
      signal,
      this.options.toolTimeoutMs ?? 120_000,
    );
    return { text: formatCallResult(result), isError: !!result.isError };
  }

  /** リソースを読む。一覧に無い URI(テンプレートから作った URI など)もサーバーに任せる */
  async read(
    server: string,
    uri: string,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
    const connection = this.connections.get(server);
    if (!connection || !connection.supports.resources)
      return {
        text: `MCP server ${server} has no readable resources`,
        isError: true,
      };
    return {
      text: formatResourceContents(await connection.readResource(uri, signal)),
      isError: false,
    };
  }

  async prompt(
    server: string,
    name: string,
    args: Record<string, string>,
    signal: AbortSignal,
  ): Promise<string> {
    const connection = this.connections.get(server);
    if (!connection || !this.findPrompt(server, name))
      throw new Error(`MCP prompt ${server}/${name} is not available`);
    return formatPromptMessages(await connection.getPrompt(name, args, signal));
  }

  async close() {
    this.closed = true;
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map((c) => c.close().catch(() => undefined)));
  }
}
