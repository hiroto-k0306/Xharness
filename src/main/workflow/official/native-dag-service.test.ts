import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixturePlan, fixtureWorkflowOptions } from "./fixtures.js";
import { OfficialWorkflowService } from "./service.js";
import { createIndependentValidator } from "./independent-validation.js";
import { WorkflowFailure } from "./contracts.js";
import type { AgentRequest, OfficialPlan } from "./contracts.js";
const exec = promisify(execFile);
it.each([
  "parallel",
  "unavailable",
  "question",
  "factory-parallel",
  "factory-unavailable",
  "factory-cancel",
  "factory-cleanup",
] as const)(
  "service automatic work routes %s with explicit integration consent and retained records",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "xh-dag-service-"));
    const cwd = join(root, "source"),
      home = join(root, "home");
    await mkdir(cwd);
    await writeFile(join(cwd, "add.mjs"), "export const add=(a,b)=>a-b;\n");
    await writeFile(join(cwd, "b.mjs"), "export const b=0;\n");
    await exec("git", ["init", "-q"], { cwd });
    await exec("git", ["add", "."], { cwd });
    await exec(
      "git",
      [
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@local",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd },
    );
    const initial = (
      await exec("git", ["rev-parse", "HEAD"], { cwd })
    ).stdout.trim();
    const first = fixturePlan().tasks[0]!;
    const plan: OfficialPlan = {
      summary: "Two independent changes",
      parallelization: {
        mode: "parallel",
        reason: "Disjoint files",
        maxParallel: 2,
      },
      validation: { testFiles: ["add.test.mjs"] },
      tasks: [
        { ...first, id: "a", files: ["add.mjs", "add.test.mjs"] },
        { ...structuredClone(first), id: "b", files: ["b.mjs"] },
      ],
    };
    const requests: AgentRequest[] = [];
    const options = fixtureWorkflowOptions(cwd);
    for (const provider of ["claude", "codex"] as const)
      options.agents[provider].run = async (request) => {
        requests.push(request);
        let output: unknown;
        if (request.phase === "plan") output = structuredClone(plan);
        else if (request.phase === "implement") {
          if (request.writeScope?.includes("b.mjs"))
            await writeFile(join(request.cwd, "b.mjs"), "export const b=1;\n");
          else {
            await writeFile(
              join(request.cwd, "add.mjs"),
              "export const add=(a,b)=>a+b;\n",
            );
            await writeFile(
              join(request.cwd, "add.test.mjs"),
              "import {test} from 'node:test';import {strict as assert} from 'node:assert';import {add} from './add.mjs';test('add',()=>assert.equal(add(2,3),5));\n",
            );
          }
          output = { summary: "Synthetic implementation", tests: [] };
        } else {
          const input = JSON.parse(request.prompt);
          output = { base: input.base, head: input.head, findings: [] };
        }
        return {
          status: "completed",
          dispatched: true,
          observedModels: [request.model.model],
          usage: null,
          elapsedMs: 1,
          output,
        };
      };
    const validator = createIndependentValidator({
      nodeExecutable: process.execPath,
      verifiedSandbox: {
        cliVersion: "fixture-only",
        commandExec: true,
        restrictedRead: true,
        networkDenied: true,
      },
      start: (workspace) => ({
        request: async (method, params, signal) => {
          if (method === "initialize") return {};
          if (method !== "command/exec") throw Error("Unexpected fixture RPC");
          const { command } = params as { command: string[] };
          const result = await exec(command[0]!, command.slice(1), {
            cwd: workspace,
            signal,
            timeout: 60000,
            maxBuffer: 65536,
          });
          return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
        },
        notify: () => {},
        subscribe: () => () => {},
        approve: () => {},
        close: () => {},
      }),
    });
    let instance: OfficialWorkflowService | undefined;
    let plans = 0,
      independent = 0;
    const seen = new Set<string>();
    const drain = () => {
      const view = instance?.view();
      if (view?.approval && !seen.has(view.approval.approvalId)) {
        const a = view.approval;
        seen.add(a.approvalId);
        plans++;
        void instance!.command({
          action: "approve",
          id: a.id,
          approvalId: a.approvalId,
          digest: a.digest,
          sessionId: "conversation",
          allow: true,
        });
      }
      if (
        view?.operationApproval &&
        !seen.has(view.operationApproval.approvalId)
      ) {
        const a = view.operationApproval;
        seen.add(a.approvalId);
        independent++;
        expect(a.source).toBe("harness-test");
        expect(a.sessionId).toBeUndefined();
        void instance!.command({
          action: "tool_decision",
          id: a.workflowId,
          approvalId: a.approvalId,
          digest: a.digest,
          sessionId: "conversation",
          allow: true,
        });
      }
    };
    const requestAbort = new AbortController();
    instance = new OfficialWorkflowService({
      home,
      fake: true,
      options: async () => options,
      validateIntegration:
        mode === "parallel" || mode === "question" ? validator : undefined,
      ...(mode.startsWith("factory-")
        ? {
            codexPath: "fixture-cli.exe",
            validationRuntime: async () => {
              if (mode === "factory-cancel") requestAbort.abort();
              if (mode === "factory-cleanup")
                throw new WorkflowFailure("validation-cleanup-unverified");
              return mode === "factory-parallel"
                ? {
                    available: true as const,
                    checkIdentity: async () => {},
                    validateIntegration: validator,
                  }
                : {
                    available: false as const,
                    reason: "validation-schema-unverified",
                  };
            },
          }
        : {}),
      onChange: () => queueMicrotask(drain),
    });
    try {
      const result = await instance.submitSession(
        {
          sessionId: "conversation",
          cwd,
          model: "claude:opus",
          effort: "high",
          text: mode === "question" ? "質問です" : "auto-work: 合成加算修正",
          history: [],
          automaticWork: true,
          autoOperations: true,
        },
        requestAbort.signal,
      );
      const record = instance.view().records[0]!.record;
      if (mode === "factory-cleanup") {
        expect(result.status).toBe("failed");
        expect(record.error).toBe("validation-cleanup-unverified");
        expect(requests).toHaveLength(0);
        expect(plans).toBe(0);
        expect(independent).toBe(0);
      } else if (mode === "factory-cancel") {
        expect(result.status).toBe("cancelled");
        expect(record.status).toBe("cancelled");
        expect(requests).toHaveLength(0);
        expect(plans).toBe(0);
        expect(independent).toBe(0);
      } else if (mode === "question") {
        expect(result.status).toBe("completed");
        expect(requests).toHaveLength(0);
        expect(plans).toBe(0);
        expect(independent).toBe(0);
      } else if (mode === "unavailable" || mode === "factory-unavailable") {
        expect(record.error).toBe("independent-validation-unavailable");
        expect(plans).toBe(0);
        expect(independent).toBe(0);
        expect(requests.map((r) => r.phase)).toEqual(["plan"]);
        expect(requests[0]!.prompt).toContain("unavailable in this runtime");
        if (mode === "factory-unavailable")
          expect(requests[0]!.prompt).toContain("validation-schema-unverified");
      } else {
        expect(record.error).toBeUndefined();
        expect(result.status).toBe("completed");
        expect(plans).toBe(1);
        expect(independent).toBe(1);
        expect(requests.filter((r) => r.phase === "plan")).toHaveLength(1);
        expect(record.dag?.nodes).toHaveLength(2);
        expect(await readFile(join(cwd, "add.mjs"), "utf8")).toContain("a-b");
        await instance.close();
        instance = new OfficialWorkflowService({ home, fake: true });
        await instance.command({ action: "list" });
        const restored = instance
          .view()
          .records.find((r) => r.record.id === record.id);
        expect(restored?.record.status).toBe("completed");
        expect(restored?.resumeBlocked).toBe(
          "native-work-resume-not-supported",
        );
      }
      expect(
        (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim(),
      ).toBe(initial);
    } finally {
      await instance.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
  30000,
);
