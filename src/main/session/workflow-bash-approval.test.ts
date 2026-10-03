// No real shell or installer runs: the Bash tool is an in-memory execution counter.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionController } from "./controller.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { lifecycleTools } from "../tools/lifecycle.js";
import { type Tool } from "../tools/registry.js";
import { type UiEvent } from "../../shared/ipc.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error("offline approval wait timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
it.each(["allow", "deny", "abort", "plan", "rule_deny"] as const)(
  "planning Bash executes only after user approval: %s",
  async (choice) => {
    const home = await mkdtemp(join(tmpdir(), "xh-workflow-bash-"));
    await writeFile(
      join(home, "config.yaml"),
      `permissions:\n  mode: ${choice === "plan" ? "plan" : "acceptEdits"}\n  rules:\n    - tool: Bash\n      decision: ${choice === "rule_deny" ? "deny" : "allow"}\nworkflow: {mode: auto, worktrees: false}\n`,
    );
    let executions = 0;
    const events: UiEvent[] = [];
    const bash: Tool = {
      spec: {
        name: "Bash",
        description: "Offline dummy",
        inputSchema: { type: "object" },
      },
      readOnly: false,
      validate: async () => undefined,
      execute: async () => {
        executions++;
        return { content: "dummy installer completed" };
      },
    };
    const c = new SessionController({
      home,
      fake: true,
      phase4: true,
      version: "test",
      model: "claude-opus-5-5",
      provider: new FakeProvider({
        script: [
          {
            type: "message",
            stopReason: "tool_use",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "dummy-bash",
                  name: "Bash",
                  input: { command: "winget install dummy" },
                },
              ],
            },
          },
          {
            type: "message",
            stopReason: "tool_use",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "stop",
                  name: "StopTask",
                  input: { reason: "offline test complete" },
                },
              ],
            },
          },
        ],
      }),
      host: { pickFolder: async () => undefined },
      emit: (e) => events.push(e),
      createTools: () => new Map([...lifecycleTools(), ["Bash", bash]]),
    });
    try {
      await c.init();
      const created = await c.handle({
        type: "new_session",
        workspaceId: null,
      });
      if (!created.ok || !created.sessionId) throw new Error("no test session");
      const sessionId = created.sessionId;
      await c.handle({
        type: "send",
        sessionId,
        text: "run dummy installer after approval",
      });
      if (choice !== "plan" && choice !== "rule_deny") {
        await until(() => events.some((e) => e.type === "permission_request"));
        const request = events.find((e) => e.type === "permission_request");
        if (!request || request.type !== "permission_request")
          throw new Error("no request");
        expect(executions).toBe(0);
        expect(request.oneTime).toBe(true);
        if (choice === "abort") await c.handle({ type: "abort", sessionId });
        else
          expect(
            await c.handle({
              type: "permission_response",
              sessionId,
              requestId: request.requestId,
              decision: choice,
            }),
          ).toMatchObject({ ok: true });
      }
      await until(() =>
        events.some((e) => e.type === "turn" && e.status === "idle"),
      );
      expect(executions).toBe(choice === "allow" ? 1 : 0);
      if (choice === "plan" || choice === "rule_deny")
        expect(events.some((e) => e.type === "permission_request")).toBe(false);
    } finally {
      await c.shutdown();
    }
  },
  15000,
);
