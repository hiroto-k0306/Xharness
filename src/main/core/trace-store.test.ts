import { mkdir, mkdtemp, readFile, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { beginTrace, withSessionTrace } from "./trace.js";
import { TRACE_WARNING, traceFiles } from "./trace-store.js";
import { runTurn } from "./loop.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { SessionStore } from "../session/store.js";
import { readTraceReplay } from "../session/report-trace.js";

const temp = () => mkdtemp(join(tmpdir(), "xh-trace-store-"));
it("recovers the sequence after a multibyte response larger than two MB", async () => {
  const home = await temp();
  await withSessionTrace(
    home,
    "wide",
    (s) => s,
    async () => beginTrace("tool", "大きな結果").end("あ".repeat(700000)),
  );
  await withSessionTrace(
    home,
    "wide",
    (s) => s,
    async () => beginTrace("tool", "再開").end(),
  );
  expect(
    (await readTraceReplay(home, "wide", (s) => s))!.records.at(-1)!.sequence,
  ).toBe(2);
});
it("rotates during a turn by bytes/rows, resumes the sequence and preserves original segments", async () => {
  const home = await temp();
  const options = { maxFileBytes: 1200, maxFileRecords: 3 };
  await withSessionTrace(
    home,
    "s",
    (s) => s,
    async () => {
      for (let i = 0; i < 12; i++)
        beginTrace("tool", "処理", { content: "x".repeat(80) }).end({
          content: i,
        });
    },
    options,
  );
  const files = await traceFiles(home, "s");
  expect(files.length).toBeGreaterThan(1);
  const original = await Promise.all(
    files.map((path) => readFile(path, "utf8")),
  );
  for (const file of original) {
    expect(Buffer.byteLength(file)).toBeLessThanOrEqual(1200);
    expect(file.trim().split("\n").length).toBeLessThanOrEqual(3);
  }
  await withSessionTrace(
    home,
    "s",
    (s) => s,
    async () => beginTrace("tool", "再開").end(),
    options,
  );
  expect(
    await Promise.all(files.map((path) => readFile(path, "utf8"))),
  ).toEqual(original);
  const replay = (await readTraceReplay(home, "s", (s) => s))!;
  expect(
    replay.records.filter((r) => r.phase === "start").map((r) => r.sequence),
  ).toEqual(Array.from({ length: 13 }, (_, i) => i + 1));
  expect(replay.records.filter((r) => r.phase === "end")).toHaveLength(13);
});

it.each(["initialization", "append"])(
  "keeps the completed turn and saved conversation after a trace %s failure",
  async (mode) => {
    const home = await temp();
    const path = join(home, "traces", "s.jsonl");
    const warnings: string[] = [];
    if (mode === "initialization") await mkdir(path, { recursive: true });
    const result = await withSessionTrace(
      home,
      "s",
      (s) => s,
      async () => {
        if (mode === "append") await mkdir(path, { recursive: true });
        return runTurn(
          {
            sessionId: "s",
            provider: new FakeProvider({
              script: [
                {
                  type: "message",
                  stopReason: "end_turn",
                  message: {
                    role: "assistant",
                    content: [{ type: "text", text: "保存失敗後も回答" }],
                  },
                },
              ],
            }),
            model: "claude-haiku-4-5",
            system: "",
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: "回答してください" }],
              },
            ],
            tools: new Map(),
            permission: async () => false,
          },
          new AbortController().signal,
        );
      },
      { onWarning: (message) => warnings.push(message) },
    );
    expect(result.stopCause).toBe("end_turn");
    expect(warnings).toEqual([TRACE_WARNING]);
    await new SessionStore(home).append("s", result.messages, (s) => s);
    expect(await readFile(join(home, "sessions", "s.jsonl"), "utf8")).toContain(
      "保存失敗後も回答",
    );
    const error = new Error("original operation failed");
    await expect(
      withSessionTrace(
        home,
        "s",
        (s) => s,
        async () => {
          throw error;
        },
        {
          onWarning: () => {
            throw new Error("observer");
          },
        },
      ),
    ).rejects.toBe(error);
  },
);

it("resumes after an interrupted last line without merging the next record into it", async () => {
  const home = await temp();
  await mkdir(join(home, "traces"));
  await writeFile(
    join(home, "traces", "s.jsonl"),
    JSON.stringify({
      id: "old",
      sequence: 19,
      phase: "start",
      kind: "tool",
      agentId: "s",
      label: "途中",
      at: "2026-10-02",
    }) + '\n{"incomplete":',
  );
  await withSessionTrace(
    home,
    "s",
    (s) => s,
    async () => beginTrace("tool", "再開").end(),
  );
  const replay = (await readTraceReplay(home, "s", (s) => s))!;
  expect(replay.skipped).toBe(1);
  expect(replay.records.at(-1)!.sequence).toBe(20);
});

it("continues from a large legacy trace and reports the omitted older segment", async () => {
  const home = await temp();
  await mkdir(join(home, "traces"));
  const path = join(home, "traces", "s.jsonl");
  const file = await open(path, "w");
  const suffix = Buffer.from(
    "\n" +
      JSON.stringify({
        id: "old",
        sequence: 91,
        phase: "end",
        kind: "tool",
        agentId: "s",
        label: "以前",
        at: "2026-10-02",
      }) +
      "\n",
  );
  await file.truncate(33_000_000);
  await file.write(suffix, 0, suffix.length, 33_000_000 - suffix.length);
  await file.close();
  const warnings: string[] = [];
  const result = await withSessionTrace(
    home,
    "s",
    (s) => s,
    async () => {
      beginTrace("tool", "継続").end();
      return "done";
    },
    { onWarning: (m) => warnings.push(m) },
  );
  expect(result).toBe("done");
  expect(warnings).toEqual([]);
  const replay = (await readTraceReplay(home, "s", (s) => s))!;
  expect(replay.omittedFiles).toBe(1);
  expect(replay.records.at(-1)!.sequence).toBe(92);
});
