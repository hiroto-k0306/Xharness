import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createDagWorkspace,
  dagWorkflowOptions,
} from "../src/main/workflow/official/dag-fixtures.js";
import { runOfficialDag } from "../src/main/workflow/official/dag.js";
import { officialWorkflowReport } from "../src/main/workflow/official/report.js";
import { withSessionTrace, withTaskTrace } from "../src/main/core/trace.js";
import { redact } from "../src/main/core/redact.js";
// No live flags, executable selection, user project, network or credentials.
const { owned, cwd } = await createDagWorkspace(),
  id = randomUUID(),
  controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  const options = dagWorkflowOptions(cwd, owned, {
    id,
    save: async (record) => {
      for (const [name, text] of [
        ["workflow.json", JSON.stringify(record, null, 2)],
        ["report.html", officialWorkflowReport(record)],
      ]) {
        const temporary = join(owned, `${randomUUID()}.tmp`);
        await writeFile(temporary, redact(text!), { mode: 0o600 });
        await rename(temporary, join(owned, name!));
      }
    },
  });
  const record = await withSessionTrace(owned, id, redact, () =>
    withTaskTrace({ taskId: id, model: options.planner.model }, async () => {
      const result = await runOfficialDag(options, controller.signal);
      return {
        ...result,
        stopCause:
          result.status === "completed"
            ? "workflow_complete"
            : result.status === "cancelled"
              ? "aborted"
              : "review_attention",
      };
    }),
  );
  console.log(
    JSON.stringify(
      {
        simulated: true,
        status: record.status,
        error: record.error,
        home: owned,
        report: join(owned, "report.html"),
        nodes: record.dag?.nodes.map((n) => ({ id: n.id, state: n.state })),
        providerQueries: 0,
      },
      null,
      2,
    ),
  );
  if (record.status !== "completed") process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
