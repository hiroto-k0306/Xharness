import { type ProviderRequest } from "../provider.js";
import { type FakeStep } from "./fake-provider.js";
/** Synthetic local scenario. No network, model quota, or Git remote is used. */
export function phase5Demo(request: ProviderRequest): FakeStep | undefined {
  const say = (text: string): FakeStep => ({
    type: "message",
    stopReason: "end_turn",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
  const call = (name: string, input: unknown): FakeStep => ({
    type: "message",
    stopReason: "tool_use",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `fake-${name}-${request.messages.length}`,
          name,
          input,
        },
      ],
    },
  });
  const lastTool = [...request.messages]
    .reverse()
    .flatMap((m) => (m.role === "assistant" ? m.content : []))
    .find((b) => b.type === "tool_use");
  const previous = lastTool?.type === "tool_use" ? lastTool.name : undefined;
  const initial =
    request.messages
      .filter(
        (m) => m.role === "user" && m.content.some((b) => b.type === "text"),
      )
      .at(-1)
      ?.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
      .join("\n") ?? "";
  if (request.system.startsWith("You are explorer"))
    return say("Fake explorer: investigation complete.");
  if (request.system.startsWith("You are reviewer")) return say("[]");
  if (
    request.system.startsWith("You are worker") &&
    initial.includes("Fake workflow demo")
  ) {
    if (previous === "Write")
      return call("ReportDone", {
        summary: "Fake workflow demo done",
        changedFiles: ["phase5-demo.txt"],
        testsRun: [],
      });
    if (previous === "Read")
      return call("Write", {
        path: "phase5-demo.txt",
        content: "Fake workflow demo\n",
      });
    return call("Read", { path: "phase5-demo.txt" });
  }
  if (
    /^task-demo\b/i.test(initial) &&
    request.tools.some((t) => t.name === "Task")
  )
    return previous === "Task"
      ? say("Fake Task demo complete.")
      : call("Task", {
          description: "Fake investigation",
          agent: "explorer",
          prompt: "Investigate locally and return final text.",
        });
  if (!/^workflow-demo\b/i.test(initial)) return;
  if (previous === "SubmitPlan")
    return call("RequestReview", { summary: "Fake workflow demo integrated" });
  if (request.tools.some((t) => t.name === "SubmitPlan"))
    return call("SubmitPlan", {
      notes:
        "Fake workflow demo: creates phase5-demo.txt and performs a mandatory review.",
      items: [
        {
          id: "P1",
          title: "Fake workflow demo",
          instructions:
            "Fake workflow demo: Write phase5-demo.txt. Read first if it exists.",
          files: ["phase5-demo.txt"],
          dependsOn: [],
          assignee: {
            agent: "worker",
            model: "codex:luna",
            effort: "low",
            reason: "Small fixture demo",
          },
          acceptance: "phase5-demo.txt exists",
        },
      ],
    });
}
