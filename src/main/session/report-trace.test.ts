import { mkdtemp, readFile, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { beginTrace, traceOperation, withSessionTrace } from "../core/trace.js";
import { runTurn } from "../core/loop.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { ClaudeAdapter } from "../providers/claude/adapter.js";
import { CodexAdapter } from "../providers/codex/adapter.js";
import { type ProviderRequest } from "../providers/provider.js";
import { runReportDemo } from "./report-demo.js";
import { readExecutionReport, renderExecutionReport } from "./report.js";
import { readTraceReplay, renderTraceReplay } from "./report-trace.js";

const temp = () => mkdtemp(join(tmpdir(), "xh-trace-"));
it("uses visible numbers for parent links when older segments are omitted", () => {
  const parent = {
    id: "parent",
    sequence: 91,
    phase: "start" as const,
    kind: "tool" as const,
    agentId: "s",
    label: "Task",
    at: "2026-10-02",
  };
  const html = renderTraceReplay({
    records: [
      parent,
      { ...parent, id: "child", sequence: 92, parentSpan: "parent" },
    ],
    skipped: 0,
    omittedFiles: 1,
  });
  expect(html).toContain('href="#trace-parent">委託元・呼び出し元 #1</a>');
  expect(html).toContain("古い分割ファイル 1 件を省略");
});
it("records all six steps, retries, rejected tools and exact parent-child delegation in a real offline loop", async () => {
  const home = await temp();
  const { id, result } = await runReportDemo(home);
  expect(result.stopCause).toBe("end_turn");
  const replay = (await readTraceReplay(home, id, (s) => s))!;
  const starts = replay.records.filter((r) => r.phase === "start");
  const steps = starts.filter((r) => r.kind === "step");
  expect(new Set(steps.map((r) => r.label))).toEqual(
    new Set(["context", "model", "tool_use", "gate", "act", "receipt"]),
  );
  expect(starts.filter((r) => r.kind === "llm")).toHaveLength(4);
  const delegation = starts.find((r) => r.kind === "delegation")!;
  const tool = starts.find((r) => r.id === delegation.parentSpan)!;
  expect(tool.callId).toBe("task-1");
  const childId = (delegation.input as { childId: string }).childId;
  expect(starts.some((r) => r.agentId === childId && r.kind === "llm")).toBe(
    true,
  );
  expect(replay.records.some((r) => r.status === "利用制限")).toBe(true);
  const html = renderExecutionReport(await readExecutionReport(home, id));
  for (const text of [
    "STEP 1",
    "STEP 6",
    "実通信なし",
    "再試行",
    "Unknown or unavailable tool",
    "エラー・拒否",
    "対象なし",
    "子ID",
    "委託元・呼び出し元",
  ])
    expect(html).toContain(text);
  const raw = await readFile(join(home, "traces", `${id}.jsonl`), "utf8");
  await withSessionTrace(
    home,
    id,
    (s) => s,
    async () => beginTrace("tool", "追加処理").end(),
  );
  expect(
    (await readTraceReplay(home, id, (s) => s))!.records.at(-1)!.sequence,
  ).toBe(starts.length + 1);
  expect(await readFile(join(home, "traces", `${id}.jsonl`), "utf8")).toMatch(
    new RegExp("^" + raw.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

it.each(["claude", "codex"] as const)(
  "records the actual %s request body and received fixture SSE without authentication values",
  async (provider) => {
    const home = await temp();
    const fixture = JSON.parse(
      await readFile(
        provider === "claude"
          ? "test/fixtures/claude/phase1-haiku-text.json"
          : "test/fixtures/codex/x2-gpt-6-luna.json",
        "utf8",
      ),
    ) as { events: { event: string; data: string }[] };
    let sent: unknown;
    const fetcher: typeof fetch = async (_url, init) => {
      sent = JSON.parse(String(init!.body));
      return new Response(
        fixture.events
          .map((e) => `event: ${e.event}\ndata: ${e.data}\n\n`)
          .join(""),
      );
    };
    const adapter =
      provider === "claude"
        ? new ClaudeAdapter({
            fetcher,
            getAccessToken: async () => "credential-do-not-save",
          })
        : new CodexAdapter({
            fetcher,
            getCredentials: async () => ({
              accessToken: "credential-do-not-save",
              accountId: "account-do-not-save",
            }),
          });
    const request: ProviderRequest = {
      model: provider === "claude" ? "claude-haiku-4-5" : "gpt-6-luna",
      system: "日本語で回答",
      messages: [
        { role: "user", content: [{ type: "text", text: "pongと返して" }] },
      ],
      tools: [],
    };
    await withSessionTrace(
      home,
      "fixture",
      (s) => s,
      () =>
        traceOperation("tool", "補助LLM通信", {}, async () => {
          for await (const event of adapter.stream(
            request,
            new AbortController().signal,
          ))
            expect(event.type).not.toBe("error");
        }),
    );
    const replay = (await readTraceReplay(home, "fixture", (s) => s))!;
    const start = replay.records.find(
      (r) => r.phase === "start" && r.kind === "llm",
    )!;

    expect(start.parentSpan).toBe(replay.records[0]!.id);
    const end = replay.records.find(
      (r) => r.id === start.id && r.phase === "end",
    )!;
    expect((end.output as { body: unknown }).body).toEqual(sent);
    const response = (end.output as { response: unknown[] }).response;
    expect(response).toContainEqual({ requestDispatched: true });
    expect(response).toContainEqual({ httpStatus: 200 });
    expect(response).toContainEqual(fixture.events[0]);
    const raw = await readFile(join(home, "traces", "fixture.jsonl"), "utf8");
    expect(raw).not.toMatch(
      /credential-do-not-save|account-do-not-save|Authorization|chatgpt-account-id/,
    );
    expect(renderTraceReplay(replay)).toContain("送信本文");
  },
);

it("persists incomplete spans, masks nested secrets before writing, and excludes invalid records", async () => {
  const home = await temp();
  await withSessionTrace(
    home,
    "partial",
    (s) => s.replaceAll("known-private", "[redacted]"),
    async () => {
      beginTrace("tool", "中断した処理", {
        content: "known-private",
        output: JSON.stringify({
          access_token: "secret-value",
          signature: "signature-value",
        }),
      });
    },
  );
  const path = join(home, "traces", "partial.jsonl");
  const raw = await readFile(path, "utf8");
  expect(raw).not.toMatch(/known-private|secret-value|signature-value/);
  await appendFile(
    path,
    "broken\n" +
      JSON.stringify({ phase: "start", kind: "execute-anything" }) +
      "\n",
  );
  const replay = (await readTraceReplay(home, "partial", (s) => s))!;
  expect(replay.skipped).toBe(2);
  expect(renderTraceReplay(replay)).toContain("終了記録なし");
  expect(await readTraceReplay(home, "old-session", (s) => s)).toBeUndefined();
  await writeFile(path, "x".repeat(32_000_001));
  await expect(readTraceReplay(home, "partial", (s) => s)).rejects.toThrow(
    "Report trace",
  );
});

it("records an aborted context step and receipt without inventing unexecuted model/gate steps", async () => {
  const home = await temp();
  const abort = new AbortController();
  abort.abort();
  await withSessionTrace(
    home,
    "aborted",
    (s) => s,
    () =>
      runTurn(
        {
          provider: new FakeProvider(),
          model: "claude-haiku-4-5",
          system: "",
          messages: [],
          tools: new Map(),
          permission: async () => false,
        },
        abort.signal,
      ),
  );
  const replay = (await readTraceReplay(home, "aborted", (s) => s))!;
  expect(
    replay.records.filter((r) => r.phase === "start").map((r) => r.label),
  ).toEqual(["context", "receipt"]);
  expect(replay.records.some((r) => r.status === "aborted")).toBe(true);
});
