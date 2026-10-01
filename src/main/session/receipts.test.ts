import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ReceiptStore } from "./receipts.js";
it("appends and reopens receipts with masked details and rejects traversal", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-receipts-"));
  const store = new ReceiptStore(home);
  const r = {
    id: "#0001",
    sessionId: "test",
    ts: 1,
    provider: "harness" as const,
    kind: "tool" as const,
    durationMs: 1,
    summary: "Read",
    input: { path: "file" },
    output: "private-token",
  };
  await Promise.all([
    store.append("test", [r], (s) => s.replaceAll("private-token", "masked")),
    store.append("test", [{ ...r, id: "#0002" }], (s) =>
      s.replaceAll("private-token", "masked"),
    ),
  ]);
  expect(await new ReceiptStore(home).read("test")).toHaveLength(2);
  expect(
    await readFile(join(home, "receipts/test.jsonl"), "utf8"),
  ).not.toContain("private-token");
  await expect(store.read("../invalid")).rejects.toThrow();
});
