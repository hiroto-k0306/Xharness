// MCP サーバーへの接続と呼び出し(DESIGN.md §25)。公式 TypeScript SDK を使う。
// electron を import しない。資格情報・トークンはここで扱わない(OAuth は §25.7、後続)。
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type McpServerConfig } from "./config.js";

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type McpStatus =
  "connected" | "failed" | "unapproved" | "rejected" | "needs_auth";

export interface McpServerState {
  name: string;
  type: McpServerConfig["type"];
  status: McpStatus;
  tools: number;
  error?: string;
}

/** callTool の結果(MCP の CallToolResult のうち使う部分) */
export interface McpCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** 1つのサーバーとの接続。試験では差し替える */
export interface McpConnection {
  listTools(signal: AbortSignal): Promise<Omit<McpToolInfo, "server">[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

export type McpConnector = (
  server: McpServerConfig,
  options: { cwd: string; onStderr(text: string): void; signal: AbortSignal },
) => Promise<McpConnection>;

export const MCP_CLIENT_INFO = { name: "xharness", version: "0.0.0" };

/** 公式 SDK による接続(stdio / Streamable HTTP) */
export const sdkConnector: McpConnector = async (server, options) => {
  const client = new Client(MCP_CLIENT_INFO, { capabilities: {} });
  let pid: number | null = null;
  const transport =
    server.type === "stdio"
      ? new StdioClientTransport({
          command: server.command!,
          args: server.args,
          // SDK の既定(PATH など最小限の変数)に .mcp.json の env を足す。親の環境変数をすべては渡さない
          env: server.env,
          cwd: options.cwd,
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(server.url!), {
          requestInit: { headers: server.headers },
        });
  if (transport instanceof StdioClientTransport)
    transport.stderr?.on("data", (chunk: Buffer) =>
      options.onStderr(chunk.toString("utf8")),
    );
  const killTree = () => {
    // Windows では npx などが孫プロセスを作るため、プロセスツリーごと止める
    if (process.platform === "win32" && pid)
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
  };
  try {
    await client.connect(transport, { signal: options.signal });
  } catch (error) {
    // 初期化の失敗・時間切れでも、起動したプロセスを残さない
    if (transport instanceof StdioClientTransport) pid = transport.pid;
    killTree();
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw error;
  }
  if (transport instanceof StdioClientTransport) pid = transport.pid;
  return {
    async listTools(signal) {
      const tools: Omit<McpToolInfo, "server">[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, {
          signal,
        });
        for (const t of result.tools)
          tools.push({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return tools;
    },
    async callTool(name, args, signal, timeoutMs) {
      return (await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: timeoutMs,
      })) as McpCallResult;
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

export class McpManager {
  private readonly connections = new Map<string, McpConnection>();
  private readonly toolList: McpToolInfo[] = [];
  private readonly state = new Map<string, McpServerState>();
  private readonly stderr = new Map<string, string>();
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
    // 名前の順にそろえる(説明文やツール一覧が接続の速さで変わらないように)
    this.toolList.sort((a, b) =>
      `${a.server}\0${a.name}`.localeCompare(`${b.server}\0${b.name}`),
    );
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
        onStderr: (text) => {
          const masked = clean(text);
          this.stderr.set(
            server.name,
            ((this.stderr.get(server.name) ?? "") + masked).slice(-2000),
          );
          this.options.log?.(server.name, masked);
        },
      });
      const tools = await connection.listTools(signal);
      if (this.closed) throw new Error("closed");
      this.connections.set(server.name, connection);
      for (const t of tools) this.toolList.push({ ...t, server: server.name });
      this.state.set(server.name, {
        name: server.name,
        type: server.type,
        status: "connected",
        tools: tools.length,
      });
    } catch (error) {
      await connection?.close().catch(() => undefined);
      const message =
        timeout.aborted && !outer.aborted
          ? "起動・初期化が時間内に終わりませんでした"
          : error instanceof Error
            ? error.message
            : "接続できませんでした";
      const unauthorized = /\b401\b|unauthori[sz]ed/i.test(message);
      this.state.set(server.name, {
        name: server.name,
        type: server.type,
        status: unauthorized ? "needs_auth" : "failed",
        tools: 0,
        error: clean(message).slice(0, 300),
      });
    }
  }

  states(): McpServerState[] {
    return [...this.state.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }
  tools(): McpToolInfo[] {
    return [...this.toolList];
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

  async close() {
    this.closed = true;
    const all = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(all.map((c) => c.close().catch(() => undefined)));
  }
}
