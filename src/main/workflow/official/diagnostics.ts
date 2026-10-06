import type { AgentRequest, AgentResult, ToolEvidence } from "./contracts.js";
import { modelName, object } from "./usage.js";
import { redact } from "../../core/redact.js";
import type { CommandShape, RejectionStage } from "./command-approval.js";

export interface ApprovalDiagnostic {
  method: string;
  decision: "allowed" | "denied";
  source: ToolEvidence["source"];
  stage?: RejectionStage;
  reason?: string;
  shape?: CommandShape;
  /** Present only for approved synthetic diagnostics, after secret redaction. */
  command?: string;
}

export interface AgentDiagnostics {
  requestId: string;
  requestedModel: string;
  resolvedRequestedModel?: string;
  cliVersion?: string;
  modelChanges?: { from: string; to: string; source: string }[];
  phase: AgentRequest["phase"];
  cwd: string;
  sandbox: string;
  approval: string;
  termination?: string;
  finalAnswer?: string;
  tools: { name: string; status: ToolEvidence["status"] }[];
  approvals?: ApprovalDiagnostic[];
  /** Number of environments in the thread/start response (null when absent). */
  threadEnvironments?: number | null;
  /** Exit codes of finished native commands; output text is never stored. */
  commandExits?: { status: "completed" | "failed"; exitCode: number | null }[];
  /** Fixed XHarness stop codes; never native text. */
  stops?: string[];
  /** Codex CodexErrorInfo variant names only; messages are never stored. */
  nativeErrors?: { source: "turn" | "notification"; info: string }[];
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
    resolvedRequestedModel: modelName(request.model.resolvedModel)
      ? request.model.resolvedModel
      : undefined,
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
    modelSwitch(from: unknown, to: unknown, source: unknown) {
      if (
        modelName(from) &&
        modelName(to) &&
        typeof source === "string" &&
        ["command", "picker", "sdk", "auto", "resume", "refusal"].includes(
          source,
        )
      ) {
        data.modelChanges ??= [];
        if (data.modelChanges.length < 20)
          data.modelChanges.push({ from, to, source });
      }
    },
    tool(e: ToolEvidence) {
      if (data.tools.length < 100)
        data.tools.push({ name: e.name, status: e.status });
    },
    commandExit(status: "completed" | "failed", exitCode: unknown) {
      data.commandExits ??= [];
      if (data.commandExits.length < 50)
        data.commandExits.push({
          status,
          exitCode:
            typeof exitCode === "number" && Number.isInteger(exitCode)
              ? exitCode
              : null,
        });
    },
    stop(code: string) {
      data.stops ??= [];
      if (data.stops.length < 20) data.stops.push(code);
    },
    nativeError(source: "turn" | "notification", raw: unknown) {
      const name =
        typeof raw === "string"
          ? raw
          : raw && typeof raw === "object"
            ? (Object.keys(raw)[0] ?? "unknown")
            : raw == null
              ? "none"
              : "unknown";
      const info = /^[A-Za-z]{1,40}$/.test(name) ? name : "unknown";
      data.nativeErrors ??= [];
      if (data.nativeErrors.length < 20)
        data.nativeErrors.push({ source, info });
      return info;
    },
    approval(entry: ApprovalDiagnostic, command?: unknown) {
      data.approvals ??= [];
      if (data.approvals.length >= 20) return;
      data.approvals.push({
        ...structuredClone(entry),
        ...(request.diagnosticText && typeof command === "string"
          ? { command: redact(safeDiagnosticText(command.slice(0, 2000))) }
          : {}),
      });
    },
    answer(value: unknown) {
      if (request.diagnosticText && typeof value === "string")
        data.finalAnswer = safeDiagnosticText(value);
    },
    claude(event: Record<string, unknown>) {
      if (
        event.type === "system" &&
        event.subtype === "init" &&
        typeof event.claude_code_version === "string" &&
        /^\d+\.\d+\.\d+$/.test(event.claude_code_version)
      )
        data.cliVersion = event.claude_code_version;
      if (event.type === "system" && event.subtype === "model_refusal_fallback")
        this.modelSwitch(event.original_model, event.fallback_model, "refusal");
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
