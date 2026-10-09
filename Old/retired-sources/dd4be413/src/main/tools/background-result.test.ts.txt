import { expect, it } from "vitest";
import { BackgroundShells } from "./background-shells.js";
import { backgroundTools } from "./background-tools.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { runTurn } from "../core/loop.js";
import { type ProviderRequest } from "../providers/provider.js";

it("keeps capped output valid after JSON serialization, masks secrets and bypasses approval only for own output", async () => {
  const shells = new BackgroundShells();
  const abort = new AbortController();
  const started = await shells.start(
    process.execPath,
    [
      "-e",
      "process.stdout.write('x'.repeat(20000)+'\\n'.repeat(20000)+'SECRET-VALUE'+'y'.repeat(20000))",
    ],
    process.cwd(),
    abort.signal,
  );
  // Observe completion without draining output, so the first model-facing page is long.
  await shells.waitForExit(started.shellId);
  const requests: ProviderRequest[] = [];
  let approvals = 0;
  const result = await runTurn(
    {
      provider: new FakeProvider({
        onRequest: (r) => requests.push(r),
        script: [
          {
            type: "message",
            stopReason: "tool_use",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "read",
                  name: "BashOutput",
                  input: { shellId: started.shellId, wait: true },
                },
              ],
            },
          },
          {
            type: "message",
            stopReason: "end_turn",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
          },
        ],
      }),
      model: "fake",
      system: "test",
      messages: [],
      tools: backgroundTools(shells),
      permission: async () => {
        approvals++;
        return false;
      },
      redact: (s) => s.replaceAll("SECRET-VALUE", "masked"),
    },
    abort.signal,
  );
  expect(approvals).toBe(0);
  expect(result.stopCause).toBe("end_turn");
  const block = requests[1]!.messages
    .flatMap((m) => m.content)
    .find((b) => b.type === "tool_result")!;
  if (block.type !== "tool_result" || typeof block.content !== "string")
    throw new Error("missing output");
  const parsed = JSON.parse(block.content);
  expect(parsed.output.length).toBeLessThanOrEqual(30000);
  expect(parsed.output).toContain("中略");
  expect(block.content).not.toContain("SECRET-VALUE");
});
