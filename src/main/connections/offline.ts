import {
  ClaudeMcpDelegation,
  ClaudeProposals,
  type SdkBinding,
} from "./claude.js";
import { MemoryIntentLedger, ToolGateway } from "./boundary.js";
import { type Action, type Input, type Outcome } from "./contracts.js";

/** Fixed development fixture and distinct held-out boundary case; no model quality claim. */
export async function compareOfflineConnections() {
  const rows: {
    fixture: string;
    variant: string;
    passed: boolean;
    outcome: Outcome;
    toolExecutions: number;
    taskElapsedMs: number;
  }[] = [];
  for (const fixture of ["fixed-echo", "heldout-denied"] as const) {
    for (const variant of ["A", "B"] as const) {
      const started = Date.now();
      const input: Input = {
        taskId: fixture,
        sessionId: `${fixture}-${variant}`,
        requestId: "one",
        model: "synthetic-sdk",
        instructions: "Return the result of the X echo action.",
        history: [{ role: "user", content: "Echo OK." }],
        tools: ["echo"],
        timeoutMs: 1000,
      };
      const scope = {
        taskId: input.taskId,
        sessionId: input.sessionId,
        requestId: input.requestId,
      };
      const action: Action = {
        id: "echo-one",
        tool: "echo",
        input: { text: "OK" },
      };
      let count = 0;
      const gateway = new ToolGateway(
        scope,
        {
          echo: {
            validate: (value) =>
              !!value &&
              typeof value === "object" &&
              (value as { text?: unknown }).text === "OK",
            execute: async () => {
              count++;
              return "OK";
            },
          },
        },
        new MemoryIntentLedger(),
        async () => fixture === "fixed-echo",
      );
      const usage = {
        input_tokens: 10,
        output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
      };
      const binding: SdkBinding = {
        subscriptionUseConfirmed: true,
        createXServer: (handlers) => handlers,
        async *query({ options }) {
          if (variant === "A")
            yield {
              type: "result",
              subtype: "success",
              structured_output: { answer: "", actions: [action] },
              usage,
            };
          else {
            const server = options.mcpServers.xharness as Record<
              string,
              (a: Action) => Promise<unknown>
            >;
            const result = (await server.echo!(action)) as {
              isError?: boolean;
            };
            yield {
              type: "result",
              subtype: "success",
              result: result.isError ? "denied" : "OK",
              usage,
            };
          }
        },
      };
      const signal = new AbortController().signal;
      let outcome: Outcome;
      let result = "";
      if (variant === "A") {
        outcome = await new ClaudeProposals(binding).infer(input, signal);
        try {
          result = await gateway.execute(
            scope,
            outcome.proposal!.actions[0]!,
            signal,
          );
        } catch {
          result = "denied";
        }
      } else {
        outcome = await new ClaudeMcpDelegation(binding, gateway).delegate(
          input,
          signal,
          () => {},
        );
        result = outcome.proposal?.answer ?? "";
      }
      const expected = fixture === "fixed-echo" ? "OK" : "denied";
      rows.push({
        fixture,
        variant,
        passed:
          outcome.status === "completed" &&
          result === expected &&
          count === (fixture === "fixed-echo" ? 1 : 0),
        outcome,
        toolExecutions: count,
        taskElapsedMs: Date.now() - started,
      });
    }
  }
  return {
    schemaVersion: 1,
    environment: "offline-injected-mock",
    measuredAt: new Date().toISOString(),
    policy:
      "Compare acceptance within each fixture first. Synthetic tokens/time are not live quality, quota or cost evidence.",
    rows,
  };
}
