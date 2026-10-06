import type { AgentRequest, AgentResult, ToolEvidence } from "./contracts.js";
import { modelName, object } from "./usage.js";

export interface AgentDiagnostics {
  requestId: string;
  requestedModel: string;
  phase: AgentRequest["phase"];
  cwd: string;
  sandbox: string;
  approval: string;
  termination?: string;
  finalAnswer?: string;
  tools: { name: string; status: ToolEvidence["status"] }[];
  sdkInitialModels: string[];
  assistants: {
    model: string | null;
    parentToolUseId: string | null | "unknown";
  }[];
  resultModelUsage: { model: string; tokens: Record<string, number> }[];
}
/** Allowlisted metadata only. No raw SDK/RPC objects, thinking or tool bodies. */
export function diagnostics(
  request: AgentRequest,
  sandbox: string,
  approval: string,
) {
  const data: AgentDiagnostics = {
    requestId: request.requestId,
    requestedModel: request.model.model,
    phase: request.phase,
    cwd: request.cwd,
    sandbox,
    approval,
    tools: [],
    sdkInitialModels: [],
    assistants: [],
    resultModelUsage: [],
  };
  return {
    data,
    tool(e: ToolEvidence) {
      if (data.tools.length < 100)
        data.tools.push({ name: e.name, status: e.status });
    },
    answer(value: unknown) {
      if (request.diagnosticText && typeof value === "string")
        data.finalAnswer = safeDiagnosticText(value);
    },
    claude(event: Record<string, unknown>) {
      if (
        event.type === "system" &&
        event.subtype === "init" &&
        modelName(event.model)
      )
        if (data.sdkInitialModels.length < 20)
          data.sdkInitialModels.push(event.model);
      if (event.type === "assistant" && data.assistants.length < 100) {
        const m = object(event.message);
        data.assistants.push({
          model: modelName(m.model) ? m.model : null,
          parentToolUseId:
            event.parent_tool_use_id === null
              ? null
              : typeof event.parent_tool_use_id === "string" &&
                  /^[A-Za-z0-9_-]{1,200}$/.test(event.parent_tool_use_id)
                ? event.parent_tool_use_id
                : "unknown",
        });
        // Only explicit text blocks on a main assistant; never thinking blocks.
        if (event.parent_tool_use_id === null && Array.isArray(m.content))
          this.answer(
            m.content
              .map(object)
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .filter((t) => typeof t === "string")
              .join("\n"),
          );
      }
      if (event.type === "result") {
        data.termination =
          typeof event.subtype === "string" &&
          /^[a-z_]{1,80}$/.test(event.subtype)
            ? event.subtype
            : "unknown";
        data.resultModelUsage = Object.entries(object(event.modelUsage))
          .filter(([m]) => modelName(m))
          .slice(0, 20)
          .map(([model, raw]) => ({
            model,
            tokens: Object.fromEntries(
              Object.entries(object(raw)).filter(
                ([key, v]) =>
                  [
                    "inputTokens",
                    "outputTokens",
                    "cacheReadInputTokens",
                    "cacheCreationInputTokens",
                  ].includes(key) &&
                  typeof v === "number" &&
                  Number.isFinite(v) &&
                  v >= 0,
              ),
            ) as Record<string, number>,
          }));
        this.answer(event.result);
      }
    },
    finish(status: AgentResult["status"]) {
      data.termination ??= status;
      return data;
    },
  };
}
export function safeDiagnosticText(text: string) {
  return text
    .slice(0, 8000)
    .replace(
      /(?:Bearer\s+|sk-[\w-]*|eyJ[\w.-]*|(?:access_token|refresh_token|authorization|chatgpt-account-id|account_id)\s*["':= ]+)[^\s,;}]+/gi,
      "[redacted]",
    );
}
