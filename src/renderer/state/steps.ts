import { type StepNode } from "../../shared/ipc.js";

/** §19.2 の STEP と役割色(§16.2) */
export const STEPS: { node: StepNode; label: string }[] = [
  { node: "context", label: "context" },
  { node: "model", label: "model" },
  { node: "tool_use", label: "tool_use" },
  { node: "gate", label: "gate" },
  { node: "act", label: "act" },
  { node: "receipt", label: "receipt" },
];

export function providerOf(model: string): "claude" | "codex" {
  return /^(gpt|o\d|codex)/i.test(model) ? "codex" : "claude";
}

/** STEP の役割色(CSS 変数名)。model だけはモデルのプロバイダ色。 */
export function stepColor(node: StepNode, model: string): string {
  switch (node) {
    case "context":
    case "receipt":
      return "var(--dim)";
    case "model":
      return providerOf(model) === "codex" ? "var(--codex)" : "var(--claude)";
    case "tool_use":
    case "gate":
      return "var(--code)";
    case "act":
      return "var(--tool)";
  }
}
