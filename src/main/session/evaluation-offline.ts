import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTurn } from "../core/loop.js";
import { withSessionTrace, withTraceFields } from "../core/trace.js";
import {
  FakeProvider,
  type FakeStep,
} from "../providers/fake/fake-provider.js";
import { type Tool, type ToolRegistry } from "../tools/registry.js";
import { evaluateTrace, type ComparisonEntry } from "./evaluation.js";
import { readTraceReplay } from "./report-trace.js";
import { exportExecutionReport } from "./report.js";
import { renderComparison } from "./evaluation-comparison.js";

interface Fixture {
  id: string;
  taskType: string;
  difficulty: string;
  prompt: string;
  initial: string;
  actions: { name: string; input: Record<string, unknown> }[];
  answer: string;
  expectedArtifact: string;
  requiredReads: number;
  requiredReviews: number;
}
/** Fixed acceptance oracles over in-memory artifacts; no shell, network or credentials. */
export async function runOfflineEvaluation(home: string) {
  await mkdir(home, { recursive: true });
  const cases: Fixture[] = JSON.parse(
    await readFile("test/fixtures/evaluation/cases.json", "utf8"),
  );
  const entries: ComparisonEntry[] = [];
  const manifest: unknown[] = [];
  const assessments: unknown[] = [];
  for (const fixture of cases) {
    for (const configuration of ["reference", "shorter-without-tools"]) {
      const sessionId = `${fixture.id}-${configuration}`;
      let artifact = fixture.initial;
      let reads = 0;
      let reviews = 0;
      const tools: ToolRegistry = new Map();
      const tool = (name: string, execute: Tool["execute"]): Tool => ({
        spec: {
          name,
          description: "Offline fixture tool",
          inputSchema: { type: "object" },
        },
        readOnly: name !== "Write",
        validate: async () => undefined,
        execute,
      });
      tools.set(
        "Read",
        tool("Read", async () => {
          reads++;
          return { content: artifact };
        }),
      );
      tools.set(
        "Write",
        tool("Write", async (input) => {
          artifact = String((input as { content: string }).content);
          return { content: "written" };
        }),
      );
      tools.set(
        "RequestReview",
        tool("RequestReview", async (_, signal) => {
          reviews++;
          const findings =
            artifact === fixture.expectedArtifact
              ? []
              : [
                  {
                    severity: "must",
                    file: "fixture.txt",
                    message: "count differs",
                  },
                ];
          const reviewer = new FakeProvider({
            provider: "codex",
            script: [
              {
                type: "message",
                stopReason: "end_turn",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: JSON.stringify(findings) }],
                },
              },
            ],
          });
          await withTraceFields(
            { agentId: `${sessionId}-review-${reviews}` },
            () =>
              runTurn(
                {
                  sessionId: `${sessionId}-review-${reviews}`,
                  provider: reviewer,
                  model: "gpt-6-luna",
                  reasoning: { effort: "low" },
                  system: "Offline reviewer",
                  messages: [],
                  tools: new Map(),
                  permission: async () => false,
                },
                signal,
              ),
          );
          return {
            content: JSON.stringify({
              phase: findings.length ? "implement" : "complete",
              findings,
            }),
          };
        }),
      );
      const script: FakeStep[] = (
        configuration === "reference" ? fixture.actions : []
      ).map((action, index) => ({
        type: "message",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `fixture-${index}`,
              name: action.name,
              input: action.input,
            },
          ],
        },
      }));
      script.push({
        type: "message",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text: fixture.answer }],
        },
      });
      const result = await withSessionTrace(
        home,
        sessionId,
        (s) => s,
        () =>
          runTurn(
            {
              sessionId,
              provider: new FakeProvider({ script }),
              model: "claude-haiku-4-5",
              reasoning: { effort: "low" },
              system: "Offline fixed fixture",
              messages: [
                {
                  role: "user",
                  content: [{ type: "text", text: fixture.prompt }],
                },
              ],
              tools,
              permission: async () => true,
            },
            new AbortController().signal,
          ),
      );
      const task = evaluateTrace(
        await readTraceReplay(home, sessionId, (s) => s),
      )[0]!;
      const last = result.messages
        .at(-1)
        ?.content.filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const checks = {
        exactAnswer: last === fixture.answer,
        exactArtifact: artifact === fixture.expectedArtifact,
        requiredRead: reads >= fixture.requiredReads,
        requiredReviews: reviews >= fixture.requiredReviews,
      };
      const passed = Object.values(checks).every(Boolean);
      const assessment = {
        source: "offline_test" as const,
        passed,
        evidence: `assessments.json: ${sessionId}; exact answer/artifact and tool counts v1`,
      };
      const entry = {
        task,
        caseId: fixture.id,
        taskType: fixture.taskType,
        difficulty: fixture.difficulty,
        criteriaVersion: "v1",
        environment: "in-memory-fake",
        configuration,
        assessment,
      };
      entries.push(entry);
      manifest.push({
        ...entry,
        task: undefined,
        taskId: task.taskId,
        home: ".",
        sessionId,
      });
      assessments.push({
        sessionId,
        checks,
        passed,
        actual: { artifact, answer: last, reads, reviews },
        expected: fixture,
      });
      await exportExecutionReport(
        home,
        sessionId,
        join(home, `${sessionId}.html`),
      );
    }
  }
  await writeFile(
    join(home, "assessments.json"),
    JSON.stringify(assessments, null, 2),
    { flag: "wx" },
  );
  await writeFile(
    join(home, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx" },
  );
  await writeFile(join(home, "comparison.html"), renderComparison(entries), {
    flag: "wx",
  });
  return entries;
}
