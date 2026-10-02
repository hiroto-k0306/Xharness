// 試験用の stdio MCP サーバー(DESIGN.md §25.10)。外部に接続しない。
// 環境変数 FIXTURE_MODE: "slow" は初期化に応答しない、"crash" は起動直後に終了する。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const mode = process.env.FIXTURE_MODE ?? "";
if (mode === "crash") {
  process.stderr.write("fixture crashed on purpose\n");
  process.exit(3);
}
if (mode === "slow") setInterval(() => {}, 1000);
else {
  const server = new Server(
    { name: "fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo the given text back",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      {
        name: "fail",
        description: "Always returns a tool error",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "env",
        description: "Return the FIXTURE_SECRET environment variable",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "big",
        description: "Return a very long text",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    switch (request.params.name) {
      case "echo":
        return { content: [{ type: "text", text: String(args.text) }] };
      case "add":
        return {
          content: [
            { type: "text", text: String(Number(args.a) + Number(args.b)) },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
        };
      case "fail":
        return { isError: true, content: [{ type: "text", text: "it failed" }] };
      case "env":
        return {
          content: [
            { type: "text", text: process.env.FIXTURE_SECRET ?? "(unset)" },
          ],
        };
      case "big":
        return { content: [{ type: "text", text: "x".repeat(40000) }] };
      default:
        throw new Error("unknown tool");
    }
  });
  process.stderr.write(`fixture started secret=${process.env.FIXTURE_SECRET}\n`);
  await server.connect(new StdioServerTransport());
}
