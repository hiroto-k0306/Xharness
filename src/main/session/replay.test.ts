import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readReceiptReplay, compareReplayPermissions } from "./replay.js";
import { buildReceiptReplay } from "../../shared/replay.js";

const tool = (name: string, input: unknown, decision = "allow") => ({
  id: "#1",
  sessionId: "session",
  ts: 0,
  provider: "harness",
  kind: "tool",
  durationMs: 1,
  summary: name,
  tool: name,
  input,
  decision,
});
it("reads parent and child files without changing them and rejects traversing ids", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-replay-"));
  await mkdir(join(home, "agents", "parent", "receipts"), { recursive: true });
  const path = join(home, "agents", "parent", "receipts", "session.jsonl");
  const raw = [
    JSON.stringify(tool("Read", { path: "a.txt" })),
    "invalid",
    JSON.stringify({ ...tool("Read", {}), sessionId: "other" }),
  ].join("\r\n");
  await writeFile(path, raw);
  const child = await readReceiptReplay(home, "session", {
    parentId: "parent",
  });
  expect(child.frames).toHaveLength(1);
  expect(child.skipped).toBe(2);
  expect(await readFile(path, "utf8")).toBe(raw);
  expect((await readReceiptReplay(home, "missing")).frames).toEqual([]);
  await expect(readReceiptReplay(home, "../escape")).rejects.toThrow("Invalid");
  await expect(
    readReceiptReplay(home, "session", { parentId: "../escape" }),
  ).rejects.toThrow("Invalid");
});
it("compares current modes/rules without executing recorded writes, Bash or hooks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-replay-gate-"));
  const file = join(cwd, "a.txt");
  await writeFile(file, "unchanged");
  const replay = buildReceiptReplay([
    tool("Write", { path: "a.txt", content: "changed" }),
    tool("Bash", { command: "Remove-Item -Recurse ." }),
    tool("Read", { path: "a.txt" }, "ask→deny"),
    {
      ...tool("hook", { command: "Set-Content a.txt changed" }),
      kind: "hook",
      provider: "hook",
    },
  ]);
  const plan = await compareReplayPermissions(
    replay,
    { mode: "plan", rules: [] },
    cwd,
    new AbortController().signal,
  );
  expect(plan.map((c) => c.current)).toEqual(["deny", "deny", "allow"]);
  expect(plan.map((c) => c.matches)).toEqual([false, false, false]);
  const edits = await compareReplayPermissions(
    replay,
    { mode: "acceptEdits", rules: [{ tool: "Read", decision: "deny" }] },
    cwd,
    new AbortController().signal,
  );
  expect(edits.map((c) => c.current)).toEqual(["allow", "ask", "deny"]);
  expect(edits[1]!.matches).toBe(false);
  expect(await readFile(file, "utf8")).toBe("unchanged");
  await expect(
    compareReplayPermissions(
      replay,
      { mode: "default", rules: [] },
      cwd,
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
});
it("reads the real Haiku child Read round trip without inventing an absent recorded decision", async () => {
  const replay = await readReceiptReplay("test/fixtures/replay", "haiku-read");
  expect(replay.skipped).toBe(0);
  expect(replay.frames.map((f) => f.receipt.kind)).toEqual([
    "model_call",
    "tool",
    "model_call",
  ]);
  expect(replay.frames[1]!.receipt.tool).toBe("Read");
  expect(replay.frames.at(-1)!.receipt.output).toContain("local read check");
  const compared = await compareReplayPermissions(
    replay,
    { mode: "default", rules: [] },
    process.cwd(),
    new AbortController().signal,
  );
  expect(compared[0]).toMatchObject({ current: "allow", matches: null });
});
