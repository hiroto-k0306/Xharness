import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  exportExecutionReport,
  readExecutionReport,
  renderExecutionReport,
} from "./report.js";
import { buildReceiptReplay } from "../../shared/replay.js";

it("exports recorded parent and child histories without changing source records", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-report-"));
  await mkdir(join(home, "receipts"));
  await mkdir(join(home, "sessions"));
  await mkdir(join(home, "agents", "haiku-read", "receipts"), {
    recursive: true,
  });
  await mkdir(join(home, "agents", "haiku-read", "sessions"));
  const raw = await readFile(
    "test/fixtures/replay/receipts/haiku-read.jsonl",
    "utf8",
  );
  const parent = join(home, "receipts", "haiku-read.jsonl");
  await writeFile(parent, raw);
  await writeFile(
    join(home, "agents", "haiku-read", "receipts", "child.jsonl"),
    raw.replaceAll('"haiku-read"', '"child"'),
  );
  await writeFile(
    join(home, "sessions", "haiku-read.jsonl"),
    JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "調査して" }],
    }) + "\ninvalid\n",
  );
  await writeFile(
    join(home, "agents", "haiku-read", "sessions", "child.jsonl"),
    JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "委託指示" }],
    }),
  );
  const output = join(home, "report.html");
  await exportExecutionReport(home, "haiku-read", output);
  const html = await readFile(output, "utf8");
  for (const text of [
    "調査して",
    "委託指示",
    "子エージェント",
    "内部共通形式",
    "不正な記録の除外 1 件",
  ])
    expect(html).toContain(text);
  expect(await readFile(parent, "utf8")).toBe(raw);
  expect(await readdir(home)).toEqual([
    "agents",
    "receipts",
    "report.html",
    "sessions",
  ]);
  await expect(
    exportExecutionReport(home, "haiku-read", parent),
  ).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(parent, "utf8")).toBe(raw);
});

it("renders untrusted text inert and masks nested output credentials and opaque reasoning", () => {
  const replay = buildReceiptReplay([
    {
      id: "#1",
      sessionId: "s",
      ts: 0,
      durationMs: 1,
      provider: "claude",
      kind: "model_call",
      summary: '<script>alert("x")</script>',
      input: {
        system: "known-private-value",
        messages: [],
        content: JSON.stringify({ authorization: "nested-private" }),
      },
      output: JSON.stringify({
        access_token: "output-private",
        signature: "private-signature",
        encrypted_content: "private-reasoning",
        text: "response",
      }),
    },
  ]);
  const html = renderExecutionReport(
    [
      {
        id: "s",
        replay,
        messages: [
          {
            role: "user",
            content: [
              {
                text: '<img src=x onerror="alert(1)">',
                account_id: "private-account",
              },
            ],
          },
        ],
        skippedMessages: 0,
      },
    ],
    (s) => s.replaceAll("known-private-value", "[redacted]"),
  );
  for (const value of [
    "known-private-value",
    "output-private",
    "private-signature",
    "private-reasoning",
    "private-account",
    "nested-private",
    "<script>",
    "<img",
  ])
    expect(html).not.toContain(value);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("response");
});

it("rejects traversal and excessive input before writing a report", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-report-limit-"));
  await expect(readExecutionReport(home, "../outside")).rejects.toThrow(
    "Invalid report session id",
  );
  await mkdir(join(home, "receipts"));
  await writeFile(join(home, "receipts", "s.jsonl"), "x".repeat(16_000_001));
  await expect(
    exportExecutionReport(home, "s", join(home, "report.html")),
  ).rejects.toThrow();
  expect(await readdir(home)).toEqual(["receipts"]);
});

it("includes a child with history but no receipts", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-report-empty-"));
  await mkdir(join(home, "agents", "s", "sessions"), { recursive: true });
  await writeFile(
    join(home, "agents", "s", "sessions", "c.jsonl"),
    JSON.stringify({
      role: "user",
      content: [{ type: "text", text: "delegated" }],
    }),
  );
  const agents = await readExecutionReport(home, "s");
  expect(agents).toHaveLength(2);
  expect(renderExecutionReport(agents)).toContain("レシートはありません");
  expect(renderExecutionReport(agents)).toContain("delegated");
});
