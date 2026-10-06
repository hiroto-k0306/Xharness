import type { WorkflowRecord } from "../main/workflow/official/runtime.js";
import type { PendingOperation } from "../main/workflow/official/operation-approval.js";
export const OFFICIAL_WORKFLOW_CHANNEL = "xharness:official-workflow";
export type OfficialWorkflowCommand =
  | { action: "list" }
  | { action: "configure"; codexPath: string }
  | { action: "workspace_root"; path: string }
  | { action: "chat"; provider: "claude" | "codex"; text: string }
  | { action: "create"; provider: "claude" | "codex"; mode?: "single" | "dag" }
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
  available: boolean;
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
