import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  evaluateTrace,
  type ComparisonEntry,
} from "../src/main/session/evaluation.js";
import { readTraceReplay } from "../src/main/session/report-trace.js";
import { renderComparison } from "../src/main/session/evaluation-comparison.js";

const [manifestPath, output] = process.argv.slice(2);
if (!manifestPath || !output)
  throw new Error(
    "Usage: pnpm evaluation:compare manifest.json new-report.html",
  );
const path = resolve(manifestPath);
if ((await stat(path)).size > 1_000_000)
  throw new Error("Manifest exceeds size limit");
const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
if (!Array.isArray(manifest) || manifest.length > 100)
  throw new Error("Manifest must be an array of up to 100 runs");
const entries: ComparisonEntry[] = [];
for (const run of manifest) {
  if (
    !run ||
    typeof run !== "object" ||
    [
      "home",
      "sessionId",
      "taskId",
      "caseId",
      "taskType",
      "difficulty",
      "criteriaVersion",
      "environment",
      "configuration",
    ].some((key) => typeof run[key] !== "string" || !run[key].trim())
  )
    throw new Error("Missing comparison conditions or task selection");
  if (
    run.assessment &&
    (!["offline_test", "explicit_evaluation"].includes(run.assessment.source) ||
      typeof run.assessment.passed !== "boolean" ||
      typeof run.assessment.evidence !== "string" ||
      !run.assessment.evidence.trim())
  )
    throw new Error("Invalid explicit assessment");
  const trace = await readTraceReplay(
    resolve(dirname(path), run.home),
    run.sessionId,
    (s) => s,
  );
  const task = evaluateTrace(trace).find((t) => t.taskId === run.taskId);
  if (!task) throw new Error("Selected recorded task not found");
  entries.push({
    task,
    caseId: run.caseId,
    taskType: run.taskType,
    difficulty: run.difficulty,
    criteriaVersion: run.criteriaVersion,
    environment: run.environment,
    configuration: run.configuration,
    assessment: run.assessment,
  });
}
await writeFile(resolve(output), renderComparison(entries), {
  encoding: "utf8",
  flag: "wx",
});
process.stdout.write(
  "Evaluation comparison saved (offline; no providers invoked)\n",
);
