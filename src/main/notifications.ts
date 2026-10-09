import type { UiEvent } from "../shared/ipc.js";
import type { OfficialWorkflowView } from "../shared/official-workflow.js";

/** Match electron-builder's identity without changing OS permissions or shortcuts. */
export function initializeNotificationIdentity(
  platform: string,
  fake: boolean,
  setAppUserModelId: (id: string) => void,
) {
  if (platform !== "win32" || fake) return;
  try {
    setAppUserModelId("local.xharness.app");
  } catch {
    /* Optional notification identity must not block application startup. */
  }
}

export type NotificationFocus = Extract<
  UiEvent,
  { type: "notification_focus" }
>;
export interface NotificationHost {
  supported(): boolean;
  show(title: string, body: string, click: () => void): void;
  focus(event: NotificationFocus): void;
}
const terminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "attention",
  "quota-paused",
]);
/** Only live transitions; templates never contain conversation or operation data. */
export class UserNotifications {
  private sessions = new Set<string>();
  private running = new Set<string>();
  private waits = new Set<string>();
  private workflowStates = new Map<string, string>();
  private workflowReady = false;
  private runIds = new Map<string, number>();
  private failed = new Set<string>();
  constructor(private host: NotificationHost) {}
  private notify(key: string, body: string, focus: NotificationFocus) {
    if (this.waits.has(key)) return;
    this.waits.add(key);
    try {
      if (!this.host.supported()) return;
      this.host.show("XHarness", body, () => {
        try {
          if (this.sessions.has(focus.sessionId)) this.host.focus(focus);
        } catch {
          /* Notification failure never changes execution. */
        }
      });
    } catch {
      /* OS notifications are optional. */
    }
  }
  event(event: UiEvent) {
    if (event.type === "state") {
      this.sessions = new Set(event.state.sessions.map((s) => s.id));
      return;
    }
    if (
      !("sessionId" in event) ||
      !event.sessionId ||
      !this.sessions.has(event.sessionId)
    )
      return;
    const sessionId = event.sessionId;
    if (event.type === "turn") {
      if (event.status === "running") {
        if (!this.running.has(sessionId)) {
          this.runIds.set(sessionId, (this.runIds.get(sessionId) ?? 0) + 1);
          this.failed.delete(sessionId);
        }
        this.running.add(sessionId);
      } else if (this.running.delete(sessionId)) {
        if (event.stopCause === "awaiting_user") return;
        this.notify(
          `turn:${sessionId}:${this.runIds.get(sessionId)}`,
          this.failed.has(sessionId) ||
            (event.stopCause &&
              ![
                "end_turn",
                "workflow_complete",
                "official_workflow_complete",
              ].includes(event.stopCause))
            ? "実行が停止しました。アプリで結果を確認してください。"
            : "実行が終了しました。アプリで結果を確認してください。",
          { type: "notification_focus", sessionId },
        );
      }
    } else {
      if (
        event.type === "permission_request" ||
        event.type === "rewind_request"
      )
        this.notify(
          `request:${sessionId}:${event.requestId}`,
          "確認が必要です。アプリで内容を確認してください。",
          {
            type: "notification_focus",
            sessionId,
            approvalId: event.requestId,
          },
        );
      else if (event.type === "error" && this.running.has(sessionId))
        this.failed.add(sessionId);
      else if (event.type === "official_scope_required" && event.text)
        this.notify(
          `scope:${sessionId}:${this.runIds.get(sessionId)}`,
          "入力が必要です。アプリで内容を確認してください。",
          { type: "notification_focus", sessionId },
        );
    }
  }
  workflow(view: OfficialWorkflowView) {
    const initial = !this.workflowReady;
    this.workflowReady = true;
    for (const { record } of view.records) {
      const previous = this.workflowStates.get(record.id);
      this.workflowStates.set(record.id, record.status);
      const sessionId = record.sessionId;
      if (initial) {
        if (view.approval?.id === record.id)
          this.waits.add(
            `plan:${record.id}:${view.approval.approvalId}:${view.approval.digest}`,
          );
        if (view.operationApproval?.workflowId === record.id)
          this.waits.add(
            `operation:${record.id}:${view.operationApproval.approvalId}:${view.operationApproval.digest}`,
          );
      }
      if (initial || !sessionId || !this.sessions.has(sessionId)) continue;
      const focus: NotificationFocus = {
        type: "notification_focus",
        sessionId,
        workflowId: record.id,
      };
      if (view.approval?.id === record.id)
        this.notify(
          `plan:${record.id}:${view.approval.approvalId}:${view.approval.digest}`,
          "計画の承認が必要です。アプリで確認してください。",
          { ...focus, approvalId: view.approval.approvalId },
        );
      if (view.operationApproval?.workflowId === record.id)
        this.notify(
          `operation:${record.id}:${view.operationApproval.approvalId}:${view.operationApproval.digest}`,
          "操作の承認が必要です。アプリで確認してください。",
          { ...focus, approvalId: view.operationApproval.approvalId },
        );
      if (
        previous &&
        previous !== record.status &&
        terminal.has(record.status) &&
        !(
          record.status === "completed" &&
          record.inputIntent === "work" &&
          !record.nativeWork &&
          !record.plan
        )
      ) {
        this.running.delete(sessionId); // One terminal notification, not a second turn/idle toast.
        this.notify(
          `terminal:${record.id}:${record.status}`,
          record.status === "completed"
            ? "作業が終了しました。アプリで結果を確認してください。"
            : "作業が停止しました。アプリで結果を確認してください。",
          focus,
        );
      }
    }
  }
}
