import type { WorkflowRecord } from "../main/workflow/official/runtime.js";
export const OFFICIAL_WORKFLOW_CHANNEL = "xharness:official-workflow";
export type OfficialWorkflowCommand =
  | { action: "list" }
  | { action: "configure"; codexPath: string }
  | { action: "chat"; provider: "claude" | "codex"; text: string }
  | { action: "create"; provider: "claude" | "codex"; mode?: "single" | "dag" }
  | { action: "approve"; id: string; digest: string }
  | { action: "cancel" | "resume"; id: string };
export interface OfficialWorkflowView {
  available: boolean;
  simulated: boolean;
  connection?: {
    codexPath: string;
    status: "unconfigured" | "configured";
    message: string;
  };
  activeId?: string;
  approval?: { id: string; digest: string };
  records: {
    record: WorkflowRecord;
    resumeBlocked: string | null;
    reportHref: string;
  }[];
  error?: string;
}
