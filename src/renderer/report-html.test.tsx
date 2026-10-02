import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReportDemo } from "../main/session/report-demo.js";
import { readExecutionReport } from "../main/session/report.js";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { renderExecutionReport } from "../main/session/report.js";
import { buildReceiptReplay } from "../shared/replay.js";
import { type Receipt } from "../shared/ipc.js";

it("uses the same card structure for every receipt and highlights only recorded model calls", () => {
  const kinds: Receipt["kind"][] = [
    "model_call",
    "tool",
    "permission",
    "fallback",
    "compact",
    "hook",
  ];
  const values = kinds.map((kind, i) => ({
    id: `#${i}`,
    sessionId: "s",
    kind,
    provider:
      kind === "model_call" || kind === "compact"
        ? "claude"
        : kind === "hook"
          ? "hook"
          : "harness",
    ts: i,
    durationMs: 1,
    summary: `${kind}: recorded`,
    ...(kind === "tool"
      ? { tool: "Read", input: { path: "a.txt" }, output: "file body" }
      : {}),
  }));
  const html = renderExecutionReport([
    {
      id: "s",
      messages: [],
      skippedMessages: 0,
      replay: buildReceiptReplay(values),
    },
  ]);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const cards = [...doc.querySelectorAll("article.receipt-card")];
  expect(cards).toHaveLength(6);
  for (const [i, card] of cards.entries()) {
    expect(card.querySelector(".receipt-process > h4")?.textContent).toBe(
      "処理",
    );
    expect(
      [...card.querySelectorAll(".exchange > div > h4")].map(
        (h) => h.textContent,
      ),
    ).toEqual(["入力", "出力"]);
    expect(card.querySelector(".raw > summary")?.textContent).toBe("詳細");
    expect(card.classList.contains("model")).toBe(i === 0);
    expect(card.querySelector(".badge")?.textContent).toBe(
      i === 0 ? "LLM" : "ハーネス",
    );
  }
  expect(cards[1]!.querySelector(".exchange")?.textContent).toContain(
    "file body",
  );
  expect(cards[2]!.querySelector(".exchange")?.textContent).toContain(
    "入力は未記録",
  );
  expect(cards[2]!.querySelector(".exchange")?.textContent).toContain(
    "出力は未記録",
  );
});

it("keeps readable input inside each collapsed card and full JSON in its own details", async () => {
  const raw = await readFile(
    "test/fixtures/replay/receipts/haiku-read.jsonl",
    "utf8",
  );
  const replay = buildReceiptReplay(
    raw
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown),
  );
  const html = renderExecutionReport([
    { id: "haiku-read", messages: [], skippedMessages: 0, replay },
  ]);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const calls = doc.querySelectorAll("article.model");
  expect(calls).toHaveLength(2);
  expect(
    calls[0]!.querySelector(".exchange")?.closest("details")?.className,
  ).toBe("receipt-collapse");
  expect(calls[0]!.querySelector(".exchange")?.textContent).toContain(
    "ファイルを読む",
  );
  expect(calls[1]!.querySelector(".exchange")?.textContent).toContain(
    "前回から追加した情報 2 件",
  );
  expect(calls[1]!.querySelector(".exchange")?.textContent).not.toContain(
    "Read a.txt with Read exactly once",
  );
  expect(calls[1]!.querySelector(".raw")?.textContent).toContain(
    "Read a.txt with Read exactly once",
  );
  expect([...doc.querySelectorAll("details")].every((d) => !d.open)).toBe(true);
  expect(doc.querySelectorAll("script,iframe,img")).toHaveLength(0);
});

it("renders all recorded demo steps with shared cards, only LLM call highlights and valid parent links", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-report-dom-"));
  const { id } = await runReportDemo(home);
  const agents = await readExecutionReport(home, id);
  const replay = agents[0]!.trace;
  const html = renderExecutionReport(agents);
  document.body.innerHTML = html;
  const cards = [...document.querySelectorAll('[id^="trace-"]')];
  expect(cards).toHaveLength(
    replay!.records.filter((r) => r.phase === "start").length,
  );
  for (const card of cards)
    expect(
      [
        ...card.querySelectorAll(
          ":scope > .receipt-collapse > .receipt-body > .receipt-process > h4, :scope > .receipt-collapse > .receipt-body > .exchange > div > h4",
        ),
      ].map((h) => h.textContent),
    ).toEqual(["処理", "入力", "出力"]);
  expect(cards.filter((c) => c.classList.contains("model"))).toHaveLength(4);
  expect(document.querySelector("details[open]")).toBeNull();
  const collapses = cards.map((c) =>
    c.querySelector<HTMLDetailsElement>(".receipt-collapse")!,
  );
  collapses[0]!.querySelector<HTMLElement>("summary")!.click();
  expect(collapses[0]!.open).toBe(true);
  expect(collapses[1]!.open).toBe(false);
  collapses[0]!.querySelector<HTMLElement>("summary")!.click();
  expect(collapses[0]!.open).toBe(false);
  expect(document.querySelector(".report-overview")?.textContent).toContain(
    "模擬：4",
  );
  expect(document.querySelector(".report-overview")?.textContent).toContain(
    "ツール実行：2",
  );
  expect(document.querySelector(".report-overview")?.textContent).toContain(
    "権限拒否：1",
  );
  const contextInput = cards[0]!.querySelector(".exchange > div")!;
  expect(contextInput.textContent).toContain("依頼・追加の指示");
  expect(contextInput.textContent).not.toContain("LLMの返答");
  for (const link of document.querySelectorAll('a[href^="#trace-"]'))
    expect(
      document.getElementById(link.getAttribute("href")!.slice(1)),
    ).not.toBeNull();
});
