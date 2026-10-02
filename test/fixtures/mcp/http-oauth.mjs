// 試験用の OAuth 付き Streamable HTTP MCP サーバー(DESIGN.md §25.7・§25.10)。
// 127.0.0.1 だけで待ち受け、外部に接続しない。認可サーバーと MCP サーバーを同じポートに置く。
// 認可はユーザー操作なしで即座にコードを返す(SDK の試験用プロバイダ)。
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { DemoInMemoryAuthProvider } from "@modelcontextprotocol/sdk/examples/server/demoInMemoryOAuthProvider.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export async function startOAuthMcpServer() {
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  const provider = new DemoInMemoryAuthProvider();
  const listener = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = new URL(`http://127.0.0.1:${listener.address().port}`);
  const mcpUrl = new URL("/mcp", base);
  const stats = { registrations: 0, tokens: 0 };
  app.use((req, _res, next) => {
    if (req.method === "POST" && req.path === "/register") stats.registrations++;
    if (req.method === "POST" && req.path === "/token") stats.tokens++;
    next();
  });
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: base,
      resourceServerUrl: mcpUrl,
      scopesSupported: ["mcp:tools"],
    }),
  );
  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  app.post("/mcp", auth, async (req, res) => {
    const server = new Server(
      { name: "oauth-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "whoami",
          description: "Return the authenticated client id",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (_r, extra) => ({
      content: [{ type: "text", text: `client:${extra.authInfo?.clientId ? "ok" : "none"}` }],
    }));
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  for (const method of ["get", "delete"])
    app[method]("/mcp", (_req, res) => res.status(405).end());
  return {
    url: mcpUrl.href,
    stats,
    close: () =>
      new Promise((resolve) => {
        listener.closeAllConnections?.();
        listener.close(() => resolve(undefined));
      }),
  };
}
