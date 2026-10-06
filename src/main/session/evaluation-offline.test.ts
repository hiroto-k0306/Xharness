import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runOfflineEvaluation } from "./evaluation-offline.js";

it("replays fixed tasks and rejects cheaper self-reported completions with independent artifact oracles", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-offline-eval-"));
  const entries = await runOfflineEvaluation(home);
  expect(entries).toHaveLength(6);
  expect(
    entries
      .filter((e) => e.configuration === "reference")
      .every((e) => e.assessment?.passed),
  ).toBe(true);
  expect(
    entries
      .filter((e) => e.configuration !== "reference")
      .every((e) => e.task.outcome === "completed" && !e.assessment?.passed),
  ).toBe(true);
  const repair = entries.find(
    (e) => e.caseId === "review-repair-v1" && e.configuration === "reference",
  )!;
  expect(repair.task.reviewAttempts).toBe(2);
  expect(repair.task.correctionRounds).toBe(1);
  expect(new Set(repair.task.calls.map((c) => c.agentId)).size).toBe(3);
  expect(await readFile(join(home, "comparison.html"), "utf8")).toContain(
    "参考値",
  );
  await expect(runOfflineEvaluation(home)).rejects.toMatchObject({
    code: "EEXIST",
  });
});
