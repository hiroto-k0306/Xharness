// セッション開始時の MCP の準備(DESIGN.md §25.3)。承認したサーバーだけに接続し、
// 窓口ツールを tools に加える。tools はこの後のセッション中に変えない(§24)。
// electron を import しない。
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_MCP } from "../config/config.js";
import { workspaceKey } from "../config/trust.js";
import { McpApprovals } from "../mcp/approvals.js";
import {
  displayServer,
  loadMcpConfig,
  type McpServerConfig,
} from "../mcp/config.js";
import { McpManager } from "../mcp/manager.js";
import { createMcpOAuth } from "../mcp/oauth.js";
import { mcpTools } from "../tools/mcp.js";
import { type ControllerContext, type Runtime } from "./context.js";
import { type PermissionGate } from "./permission-gate.js";
import { type StoredSession } from "./store.js";

/** 認可で開いてよい URL: https、または手元(loopback)の http */
export function isAuthorizationUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" ||
      (u.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))
    );
  } catch {
    return false;
  }
}

/** サーバーの stderr(マスク済み)をワークスペースごとのログへ追記する。失敗しても止めない */
export async function mcpLogger(home: string, root: string) {
  const dir = join(home, "logs", "mcp", await workspaceKey(root));
  return (server: string, text: string) => {
    void mkdir(dir, { recursive: true })
      .then(() => appendFile(join(dir, `${server}.log`), text, "utf8"))
      .catch(() => undefined);
  };
}

export async function prepareMcp(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  signal: AbortSignal,
): Promise<void> {
  if (rt.mcpPrepared) return;
  rt.mcpPrepared = true;
  const { options } = ctx;
  const root = ctx.workspaceRoot(session);
  const settings = rt.mainConfig?.mcp ?? DEFAULT_MCP;
  // --fake は MCP サーバーを起動しない(§25.8)。作業フォルダの無いセッションは対象外
  if ((options.fake && !options.mcpConnector) || !root || !settings.enabled)
    return;
  const config = await loadMcpConfig(root);
  if (!config.exists) return;
  const notice = (message: string, tone: "warn" | "dim" = "warn") =>
    options.emit({
      type: "notice",
      sessionId: session.id,
      tone,
      message: ctx.clean(message),
    });
  for (const warning of config.warnings) notice(warning);
  const manager = new McpManager({
    cwd: session.cwd,
    connector: options.mcpConnector,
    startupTimeoutMs: settings.startupTimeoutSec * 1000,
    toolTimeoutMs: settings.toolTimeoutSec * 1000,
    redact: ctx.clean,
    log: await mcpLogger(options.home, root),
    oauth:
      options.mcpSecrets && options.openExternal
        ? createMcpOAuth({
            store: options.mcpSecrets,
            scope: await workspaceKey(root),
            openBrowser: (url) => {
              // サーバーが示す認可の URL。https(または手元の http)だけを開く
              if (!isAuthorizationUrl(url))
                throw new Error("Unsafe authorization URL");
              notice(
                `MCP サーバーの認可のため、ブラウザで ${new URL(url).host} を開きます。認可すると接続を続けます`,
                "dim",
              );
              options.openExternal!(url);
            },
          })
        : undefined,
  });
  rt.mcp = manager;
  // .mcp.json があれば、接続の成否によらず窓口ツールを加える(セッション中に tools を変えないため)
  const addTools = () => {
    for (const [name, tool] of mcpTools(manager)) rt.tools?.set(name, tool);
  };
  const trusted =
    rt.trustedSession || (await ctx.trust.isTrusted(root).catch(() => false));
  if (!trusted) {
    notice(
      "このワークスペースを信頼していないため、.mcp.json の MCP サーバーは起動しません",
    );
    for (const server of config.servers) manager.skip(server, "unapproved");
    addTools();
    return;
  }
  const approvals = await McpApprovals.open(options.home, root);
  const approved: McpServerConfig[] = [];
  for (const server of config.servers) {
    const saved = await approvals.get(server.name, server.hash);
    if (saved === "approved") {
      approved.push(server);
      continue;
    }
    if (saved === "rejected") {
      manager.skip(server, "rejected");
      continue;
    }
    const decision = await gate.request({
      session,
      rt,
      call: { name: "McpServer", input: displayServer(server) },
      signal,
      forceAsk: true,
    });
    if (decision === "always")
      await approvals.set(server.name, server.hash, "approved");
    if (decision === "deny") manager.skip(server, "unapproved");
    else approved.push(server);
  }
  if (approved.length) await manager.connect(approved, signal);
  for (const state of manager.states())
    if (state.status === "failed" || state.status === "needs_auth")
      notice(
        `MCP サーバー ${state.name} に接続できませんでした: ${state.error ?? state.status}`,
      );
  const connected = manager.servers();
  if (connected.length)
    notice(
      `MCP: ${connected.join(", ")} に接続しました(ツール ${manager.tools().length} 個)`,
      "dim",
    );
  addTools();
}

/**
 * まだ会話に伝えていない MCP の一覧の変化を、user メッセージに添える注記にする(§25.4)。
 * tools と system は変えず、履歴に残る形で伝える(過去の thinking の前提を変えないため)。
 */
export function mcpChangeNote(
  manager: McpManager | undefined,
): string | undefined {
  const changes = manager?.takeChanges() ?? [];
  if (!changes.length) return undefined;
  const lines = changes.map((c) => {
    const parts = [
      c.added.length ? `added ${c.added.join(", ")}` : "",
      c.removed.length ? `removed ${c.removed.join(", ")}` : "",
    ].filter(Boolean);
    return `- ${c.server} ${c.kind}: ${parts.join("; ")}`;
  });
  return `[MCP update] The available MCP ${changes.some((c) => c.kind === "tools") ? "tools/resources" : "resources"} changed. Use McpSearch / ListMcpResources for details.\n${lines.join("\n")}`;
}

/** `/mcp__<server>__<prompt> 引数…` の形か */
export const MCP_PROMPT_COMMAND =
  /^\/mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__(\S+)(?:\s+([\s\S]*))?$/;

/** `/mcp__<server>__<prompt> 引数…` を読み、プロンプトの arguments に割り当てる */
export function parseMcpPrompt(
  manager: McpManager | undefined,
  text: string,
):
  | { server: string; name: string; args: Record<string, string> }
  | { error: string } {
  const match = MCP_PROMPT_COMMAND.exec(text.trim());
  if (!match) return { error: "MCP のプロンプトの形式ではありません" };
  const [, server = "", name = "", rest = ""] = match;
  const prompt = manager?.findPrompt(server, name);
  if (!prompt)
    return {
      error: `MCP のプロンプト ${server}/${name} はありません(接続中のサーバーを確認してください)`,
    };
  const words = rest.trim() ? rest.trim().split(/\s+/) : [];
  const args: Record<string, string> = {};
  prompt.arguments.forEach((a, i) => {
    const last = i === prompt.arguments.length - 1;
    const value = last ? words.slice(i).join(" ") : words[i];
    if (value) args[a.name] = value;
  });
  const missing = prompt.arguments
    .filter((a) => a.required && !args[a.name])
    .map((a) => a.name);
  if (missing.length)
    return { error: `必須の引数が足りません: ${missing.join(", ")}` };
  return { server, name, args };
}

/**
 * MCP のプロンプトを展開する(§25.6)。引数は空白区切りで、プロンプトの arguments の順に割り当て、
 * 残りは最後の引数にまとめる。内容を確認画面で見せ、許可されたら user の入力として返す。
 */
export async function expandMcpPrompt(
  ctx: ControllerContext,
  gate: PermissionGate,
  session: StoredSession,
  rt: Runtime,
  text: string,
  signal: AbortSignal,
): Promise<{ text: string } | { error: string }> {
  const parsed = parseMcpPrompt(rt.mcp, text);
  if ("error" in parsed) return parsed;
  const { server, name, args } = parsed;
  let expanded: string;
  try {
    expanded = await rt.mcp!.prompt(server, name, args, signal);
  } catch (error) {
    return {
      error: ctx.clean(
        `MCP のプロンプトを取得できませんでした: ${error instanceof Error ? error.message : ""}`,
      ),
    };
  }
  if (!expanded.trim()) return { error: "MCP のプロンプトが空でした" };
  const decision = await gate.request({
    session,
    rt,
    call: {
      name: "McpPrompt",
      input: {
        prompt: `mcp__${server}__${name}`,
        arguments: args,
        text: expanded.slice(0, 4000),
      },
    },
    signal,
    forceAsk: true,
  });
  if (decision === "deny")
    return { error: "MCP のプロンプトの送信を取りやめました" };
  return { text: expanded };
}
