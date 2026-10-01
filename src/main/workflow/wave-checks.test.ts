import { it, expect } from "vitest";
import { waveChecks } from "./wave-checks.js";
import { type Tool } from "../tools/registry.js";
it("never executes unapproved project hooks, approves the list once and stops on a failing check", async () => {
  const calls: string[] = [];
  let approve = false;
  let approvals = 0;
  const bash: Tool = {
    spec: { name: "Bash", description: "Test", inputSchema: {} },
    readOnly: false,
    validate: async () => undefined,
    execute: async (input) => {
      const command = (input as { command: string }).command;
      calls.push(command);
      return { content: command, isError: command === "fail" };
    },
  };
  const checks = waveChecks(
    [
      { id: "test", command: "test", timeoutSec: 60, project: true },
      { id: "bad", command: "fail", timeoutSec: 60, project: false },
      { id: "later", command: "never", timeoutSec: 60, project: false },
    ],
    bash,
    async () => {
      approvals++;
      return approve;
    },
  );
  expect((await checks(new AbortController().signal)).ok).toBe(false);
  expect(calls).toEqual([]);
  approve = true;
  expect((await checks(new AbortController().signal)).ok).toBe(false);
  expect((await checks(new AbortController().signal)).ok).toBe(false);
  expect(approvals).toBe(2);
  expect(calls).toEqual(["test", "fail", "test", "fail"]);
});
