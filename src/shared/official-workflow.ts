import type { WorkflowRecord } from "../main/workflow/official/runtime.js";
import type { PendingOperation } from "../main/workflow/official/operation-approval.js";
export const OFFICIAL_WORKFLOW_CHANNEL = "xharness:official-workflow";
/** A question model resolved from the catalog role, or why it cannot be used. */
export type QuestionModel =
  | { id: string; effort?: "low" | "medium" | "high" | "xhigh" | "max" | null }
  | { error: string };
export type OfficialWorkflowCommand =
  | { action: "list" }
  | { action: "configure"; codexPath: string }
  | { action: "configure_auto" }
  | { action: "workspace_root"; path: string }
  | { action: "chat"; provider: "claude" | "codex"; text: string }
  | {
      action: "create";
      provider: "claude" | "codex";
      mode?: "single" | "dag";
      /** Verification-only fix-cycle task; refused unless the mode is on. */
      task?: "typed-add-v1";
      /** Saved main-model policy; each new call resolves the current catalog ID. */
      planner?: {
        model: string;
        effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
      };
    }
  | {
      action: "approve";
      id: string;
      digest: string;
      approvalId?: string;
      sessionId?: string;
      allow?: boolean;
    }
  | {
      action: "tool_decision";
      id: string;
      approvalId: string;
      /** Application conversation ID, never the native provider thread ID. */
      sessionId?: string;
      digest: string;
      allow: boolean;
      scope?: "flow";
    }
  | { action: "cancel"; id: string; sessionId?: string }
  | { action: "resume"; id: string };
export interface OfficialWorkflowView {
  claudeRuntime?: import("./sdk-runtime.js").SdkRuntimeView;
  /** Workflow (plan / implement / review) can start: storage and both connections configured. */
  available: boolean;
  /** Storage is usable; a question to Claude needs nothing else configured. */
  storageReady?: boolean;
  /** The same catalog resolution the service uses when sending a question. */
  questionModels?: Record<"claude" | "codex", QuestionModel>;
  simulated: boolean;
  /** Set only in the explicit fix-cycle verification mode (fault injection). */
  verification?: "fix-cycle-v1";
  connection?: {
    codexPath: string;
    codexMode?: "auto" | "fixed";
    codexPackage?: string;
    codexError?: string;
    /** Empty means the default location under the workflow storage. */
    workspaceRoot: string;
    status: "unconfigured" | "configured";
    message: string;
  };
  activeId?: string;
  /** App conversation owner, including preparation before the first record exists. */
  activeSessionId?: string;
  approval?: {
    id: string;
    approvalId: string;
    digest: string;
    sessionId?: string;
    expiresAt: number;
    autoOperations?: boolean;
  };
  operationApproval?: PendingOperation;
  records: {
    record: WorkflowRecord;
    resumeBlocked: string | null;
    reportHref: string;
  }[];
  error?: string;
}
