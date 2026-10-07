import { mkdir, writeFile, rename, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  createSyntheticWorkspace,
  fixtureWorkflowOptions,
  fixtureAgents,
} from "../src/main/workflow/official/fixtures.js";
import {
  runOfficialSingleTask,
  workflowUsage,
  type WorkflowRecord,
} from "../src/main/workflow/official/runtime.js";
import { officialWorkflowReport } from "../src/main/workflow/official/report.js";
import { ClaudeWorkflowAgent } from "../src/main/workflow/official/claude.js";
import { CodexWorkflowAgent } from "../src/main/workflow/official/codex.js";
import { withSessionTrace, withTaskTrace } from "../src/main/core/trace.js";
import { redact } from "../src/main/core/redact.js";
import { gitWorkspace } from "../src/main/workflow/official/workspace.js";

// Development entry only: never executes against a user's project or resumes an uncertain call.
const args = process.argv.slice(2);
const value = (name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (
  args.some(
    (a) =>
      ![
        "--fake",
        "--authorized-live",
        "--synthetic-only",
        "--codex",
        "--codex-model",
        "--implement-provider",
      ].includes(a) &&
      !args.some(
        (b, i) =>
          ["--codex", "--codex-model", "--implement-provider"].includes(b) &&
          args[i + 1] === a,
      ),
  )
)
  throw new Error("Unknown workflow option");
const live = args.includes("--authorized-live");
if (
  live &&
  (args.includes("--fake") ||
    !args.includes("--synthetic-only") ||
    !value("--codex") ||
    !value("--codex-model"))
)
  throw new Error(
    "Live requires --synthetic-only, explicit --codex executable and --codex-model",
  );
const provider = value("--implement-provider") ?? "claude";
if (provider !== "claude" && provider !== "codex")
  throw new Error("Invalid implementation provider");
const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
const cwd = await createSyntheticWorkspace();
const home = await mkdtemp(join(tmpdir(), "xh-official-evidence-"));
await mkdir(home, { recursive: true });
let lastStatus = "";
const save = async (record: WorkflowRecord) => {
  for (const [name, content] of [
    ["workflow.json", JSON.stringify(record, null, 2)],
    ["report.html", officialWorkflowReport(record)],
  ]) {
    const target = join(home, name!);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, content!, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  }
  if (record.status !== lastStatus) {
    lastStatus = record.status;
    stdout.write(`workflow: ${lastStatus}\n`);
  }
};
const options = fixtureWorkflowOptions(cwd, {
  id: randomUUID(),
  agents: fixtureAgents(provider).agents,
  save,
  workspace: gitWorkspace(cwd, redact),
});
if (live) {
  const claude = new ClaudeWorkflowAgent();
  const codex = CodexWorkflowAgent.local(resolve(value("--codex")!));
  // Read-only catalogs and native subscription controls; neither adapter reads credentials.
  const models = [
    ...(await codex.discover(cwd, controller.signal)),
    ...(await claude.discover(cwd, controller.signal)),
  ];
  await writeFile(
    join(home, "capabilities.json"),
    JSON.stringify(models, null, 2),
    { mode: 0o600 },
  );
  const opus = models.find(
    (m) =>
      m.provider === "claude" &&
      (m.model === "opus" || m.resolvedModel?.includes("opus")) &&
      m.quotaAllowed === true,
  );
  const implementer =
    provider === "claude"
      ? models.find(
          (m) =>
            m.provider === "claude" &&
            (m.model === "haiku" || m.resolvedModel?.includes("haiku")) &&
            m.quotaAllowed === true,
        )
      : models.find(
          (m) =>
            m.provider === "codex" &&
            m.model === value("--codex-model") &&
            m.quotaAllowed === true,
        );
  const review = models.find(
    (m) =>
      m.provider === "codex" &&
      m.model === value("--codex-model") &&
      m.quotaAllowed === true,
  );
  if (!opus || !implementer || !review)
    throw new Error(
      `Required model or included usage unavailable; evidence directory: ${home}`,
    );
  options.simulated = false;
  options.agents = { claude, codex };
  options.models = models.filter(
    (m) => m === opus || m === implementer || m === review,
  );
  options.planner = {
    model: opus.model,
    effort: opus.efforts.includes("high") ? "high" : null,
  };
  options.reviewers = {
    claude: options.planner,
    codex: {
      model: review.model,
      effort: review.efforts.includes("low") ? "low" : null,
    },
  };
  options.goal = `Correct addition without modifying the test. Assign the single implementation task to ${provider}, model ${implementer.model}. This is a small synthetic task.`;
  options.approve = async (_plan, digest, signal) => {
    stdout.write(
      `Review ${join(home, "report.html")}\nApproval digest: ${digest}\n`,
    );
    const ui = createInterface({ input: stdin, output: stdout });
    try {
      return (
        (await ui.question(
          "Type approve to execute this exact synthetic plan: ",
          { signal },
        )) === "approve"
      );
    } finally {
      ui.close();
    }
  };
}
const result = await withSessionTrace(
  home,
  options.id!,
  (s) => s,
  () =>
    withTaskTrace(
      {
        model: options.planner!.model,
        effort: options.planner!.effort ?? undefined,
        taskId: options.id,
      },
      async () => {
        const record = await runOfficialSingleTask(options, controller.signal);
        return {
          ...record,
          stopCause:
            record.status === "completed"
              ? "workflow_complete"
              : record.status === "cancelled"
                ? "aborted"
                : "review_attention",
        };
      },
    ),
);
stdout.write(
  JSON.stringify(
    {
      status: result.status,
      simulated: result.simulated,
      workspace: cwd,
      evidence: home,
      usage: workflowUsage(result),
    },
    null,
    2,
  ) + "\n",
);
if (result.status !== "completed") process.exitCode = 1;
