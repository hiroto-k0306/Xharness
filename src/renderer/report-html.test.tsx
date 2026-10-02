import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { renderExecutionReport } from "../main/session/report.js";
import { buildReceiptReplay } from "../shared/replay.js";

it("puts the readable exchange outside closed JSON details and keeps original input available", async () => {
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
  expect(calls[0]!.querySelector(".exchange")?.closest("details")).toBeNull();
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
