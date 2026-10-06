import type { WorkflowRecord } from "../main/workflow/official/runtime.js";
import type { PendingOperation } from "../main/workflow/official/operation-approval.js";
export const OFFICIAL_WORKFLOW_CHANNEL = "xharness:official-workflow";
/** A question model resolved from the catalog role, or why it cannot be used. */
export type QuestionModel = { id: string } | { error: string };
export type OfficialWorkflowCommand =
  | { action: "list" }
  | { action: "configure"; codexPath: string }
  | { action: "workspace_root"; path: string }
  | { action: "chat"; provider: "claude" | "codex"; text: string }
  | {
      action: "create";
      provider: "claude" | "codex";
      mode?: "single" | "dag";
      /** The main model selected when the task is started; fixed for this task. */
      planner?: {
        model: string;
        effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
      };
    }
  | { action: "approve"; id: string; digest: string }
  | {
      action: "tool_decision";
      id: string;
      approvalId: string;
      digest: string;
      allow: boolean;
    }
  | { action: "cancel" | "resume"; id: string };
export interface OfficialWorkflowView {
  /** Workflow (plan / implement / review) can start: storage and both connections configured. */
  available: boolean;
  /** Storage is usable; a question to Claude needs nothing else configured. */
  storageReady?: boolean;
  /** The same catalog resolution the service uses when sending a question. */
  questionModels?: Record<"claude" | "codex", QuestionModel>;
  simulated: boolean;
  connection?: {
    codexPath: string;
    /** Empty means the default location under the workflow storage. */
    workspaceRoot: string;
    status: "unconfigured" | "configured";
    message: string;
  };
  activeId?: string;
  approval?: { id: string; digest: string };
  operationApproval?: PendingOperation;
  records: {
    record: WorkflowRecord;
    resumeBlocked: string | null;
    reportHref: string;
  }[];
  error?: string;
}
