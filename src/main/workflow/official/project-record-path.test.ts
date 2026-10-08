import { it, expect } from "vitest";
import { projectRecordPathValid } from "./project-record-path.js";
import type { WorkflowRecord } from "./runtime.js";
import { resolve, join, dirname, basename } from "node:path";
it("loads legacy locations and exact automatic destinations, not arbitrary recorded folders", () => {
  const source = resolve("fixture-project"),
    id = "00000000-0000-0000-0000-000000000001";
  const r = { id, cwd: source, project: { source } } as WorkflowRecord;
  expect(projectRecordPathValid(r)).toBe(true);
  for (const kind of [
    "local-copy",
    "git-worktree",
    "reuse-worktree",
  ] as const) {
    const destination =
      kind === "local-copy"
        ? join(source, ".xharness-workspaces", id)
        : kind === "git-worktree"
          ? join(dirname(source), "XHarness-workspaces", basename(source), id)
          : source;
    r.project!.preparation = { kind, destination, fingerprint: "a".repeat(64) };
    r.cwd = destination;
    expect(projectRecordPathValid(r)).toBe(true);
    r.cwd = resolve("outside");
    expect(projectRecordPathValid(r)).toBe(false);
    r.project!.preparation.destination = r.cwd;
    expect(projectRecordPathValid(r)).toBe(false);
  }
});
