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
import { mcpTools } from "../tools/mcp.js";
import { type ControllerContext, type Runtime } from "./context.js";
import { type PermissionGate } from "./permission-gate.js";
import { type StoredSession } from "./store.js";

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
