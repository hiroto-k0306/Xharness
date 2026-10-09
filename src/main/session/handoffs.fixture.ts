// Offline official-session evidence, independent of the obsolete model loop.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { fixture as sessionFixture } from "./improvements.fixture.js";
import { officialSessionSummary } from "../workflow/official/session-result.js";
import type { WorkflowRecord } from "../workflow/official/runtime.js";
import type { ControllerOptions } from "./controller.js";

export async function fixture(answer = "pong") {
  const official = vi.fn<NonNullable<ControllerOptions["officialSession"]>>(
    async (request) => {
      const id = randomUUID();
      const record: WorkflowRecord = {
        version: 1,
        simulated: true,
        id,
        sessionId: request.sessionId,
        goal: request.text,
        cwd: request.cwd,
        startedAt: new Date(Date.now() - 1).toISOString(),
        finishedAt: new Date().toISOString(),
        status: "completed",
        next: "complete",
        base: "a".repeat(40),
        head: "b".repeat(40),
        correctionRounds: 0,
        calls: [
          {
            requestId: randomUUID(),
            phase: "conversation",
            provider: "claude",
            requestedModel: "claude-haiku-5-5",
            effort: "low",
            status: "completed",
            dispatched: true,
            observedModels: [],
            usage: null,
            elapsedMs: 1,
          },
        ],
        inputIntent: "question",
        answer,
        tools: [],
        commits: [],
        checks: [],
        reviews: [],
      };
      const directory = join(f.home, "official-workflows", id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "workflow.json"), JSON.stringify(record));
      return {
        workflowId: id,
        status: "completed",
        summary: officialSessionSummary(record, false),
      };
    },
  );
  const f = await sessionFixture(undefined, {
    model: "claude:opus",
    officialSession: official,
  });
  return { ...f, requests: official };
}
