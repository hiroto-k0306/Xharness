import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTurn } from "../core/loop.js";
import { beginTrace, traceOperation, withSessionTrace } from "../core/trace.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { type Tool, type ToolRegistry } from "../tools/registry.js";
import { SessionStore } from "./store.js";

/** Offline demonstration. All files belong to the supplied new demo directory. */
export async function runReportDemo(home: string) {
  const id = "report-demo";
  const clean = (s: string) => s.replaceAll(home, "[デモ保存先]");
  const cwd = join(home, "workspace");
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(cwd, "README.md"),
    "XHarnessは、LLMとツールの実行を管理するハーネスです。\n",
  );
  const provider = new FakeProvider({
    script: [
      { type: "rate_limited", retryAfterSec: 0 },
      {
        type: "message",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "READMEを読み、子エージェントに説明を依頼します。",
            },
            {
              type: "tool_use",
              id: "read-1",
              name: "Read",
              input: { path: "README.md" },
            },
            {
              type: "tool_use",
              id: "unknown-1",
              name: "UnknownTool",
              input: {},
            },
            {
              type: "tool_use",
              id: "write-1",
              name: "Write",
              input: { path: "README.md", content: "変更案" },
            },
            {
              type: "tool_use",
              id: "task-1",
              name: "Task",
              input: {
                prompt: "ハーネスとLLMの役割を日本語で説明してください。",
              },
            },
          ],
        },
      },
      {
        type: "message",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "READMEの読み取りと子の説明が完了しました。不明なツールは検証で止まり、書き込みは権限で拒否されました。",
            },
          ],
        },
      },
    ],
  });
  const tools: ToolRegistry = new Map();
  const add = (name: string, tool: Omit<Tool, "spec">) =>
    tools.set(name, {
      ...tool,
      spec: {
        name,
        description: `${name}のデモ`,
        inputSchema: { type: "object" },
      },
    });
  add("Read", {
    readOnly: true,
    validate: async () => undefined,
    execute: async () => ({
      content: await readFile(join(cwd, "README.md"), "utf8"),
    }),
  });
  add("Write", {
    readOnly: false,
    validate: async () => undefined,
    execute: async () => {
      throw new Error("Denied demo tool must never execute");
    },
  });
  add("Task", {
    readOnly: false,
    validate: async () => undefined,
    execute: async (input) => {
      // Historical child-report fixture only: no child executor or model request.
      const childId = "explainer-fixture";
      const prompt = (input as { prompt: string }).prompt;
      const text =
        "LLMは次の操作を提案し、ハーネスは検証・権限確認・実行・記録を担当します。";
      return traceOperation(
        "delegation",
        "explainer",
        { childId, prompt },
        async () => {
          const childHome = join(home, "agents", id);
          const store = new SessionStore(childHome);
          await store.load();
          await store.save({
            id: childId,
            title: "explainer（静的履歴fixture）",
            workspaceId: null,
            cwd,
            model: "claude-haiku-4-5",
            effort: "high",
            readOnly: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            providers: ["claude"],
          });
          const messages = [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: prompt }],
            },
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text }],
            },
          ];
          await store.append(childId, messages, clean);
          await withSessionTrace(childHome, childId, clean, async () => {
            const span = beginTrace(
              "llm",
              "静的子履歴fixture（通信なし）",
              { messages: [messages[0]] },
              true,
            );
            span.end({ message: messages[1] }, "完了");
          });
          return { content: text };
        },
        { agentId: childId },
      );
    },
  });
  const result = await withSessionTrace(home, id, clean, () =>
    runTurn(
      {
        sessionId: id,
        provider,
        model: "claude-haiku-4-5",
        system: "学習用デモです。日本語で説明してください。",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "READMEを読んで、子エージェントにもハーネスの役割を説明してもらってください。",
              },
            ],
          },
        ],
        tools,
        permission: async (call) => call.name !== "Write",
        sleep: async () => {},
      },
      new AbortController().signal,
    ),
  );
  await new SessionStore(home).append(id, result.messages, clean);
  return { id, result };
}
