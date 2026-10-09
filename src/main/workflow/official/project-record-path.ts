import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { WorkflowRecord } from "./runtime.js";

/** Loading history does not resume execution; accept only the predetermined child location. */
export function projectRecordPathValid(record: WorkflowRecord) {
  const project = record.project;
  if (!project) return true;
  const same = (a: string, b: string) =>
    resolve(a).toLowerCase() === resolve(b).toLowerCase();
  if (!isAbsolute(project.source) || !isAbsolute(record.cwd)) return false;
  const p = project.preparation;
  if (!p) return same(project.source, record.cwd);
  if (
    !/^[a-f0-9-]{36}$/i.test(record.id) ||
    !/^[a-f0-9]{64}$/.test(p.fingerprint)
  )
    return false;
  const expected =
    p.kind === "local-copy"
      ? join(project.source, ".xharness-workspaces", record.id)
      : p.kind === "git-worktree"
        ? join(
            dirname(project.source),
            "XHarness-workspaces",
            basename(project.source),
            record.id,
          )
        : p.kind === "reuse-worktree"
          ? project.source
          : null;
  return (
    !!expected &&
    typeof p.destination === "string" &&
    isAbsolute(p.destination) &&
    same(p.destination, expected) &&
    (same(record.cwd, project.source) || same(record.cwd, expected))
  );
}
