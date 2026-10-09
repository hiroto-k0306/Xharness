import { expect, it, vi } from "vitest";
import {
  initializeNotificationIdentity,
  UserNotifications,
  type NotificationHost,
} from "./notifications.js";
import type { OfficialWorkflowView } from "../shared/official-workflow.js";
import type { UiEvent } from "../shared/ipc.js";
it("sets only the real Windows process identity to the builder appId", () => {
  const setAppUserModelId = vi.fn();
  initializeNotificationIdentity("linux", false, setAppUserModelId);
  initializeNotificationIdentity("win32", true, setAppUserModelId);
  expect(setAppUserModelId).not.toHaveBeenCalled();
  initializeNotificationIdentity("win32", false, setAppUserModelId);
  expect(setAppUserModelId).toHaveBeenCalledExactlyOnceWith(
    "local.xharness.app",
  );
  expect(() =>
    initializeNotificationIdentity("win32", false, () => {
      throw Error("unavailable");
    }),
  ).not.toThrow();
});
function setup() {
  const host: NotificationHost = {
    supported: vi.fn(() => true),
    show: vi.fn(),
    focus: vi.fn(),
  };
  const n = new UserNotifications(host);
  n.event({
    type: "state",
    state: { sessions: [{ id: "session" }] },
  } as UiEvent);
  return { n, host };
}
const view = (
  status: string,
  approval?: string,
  sessionId: string | undefined = "session",
  details: Partial<OfficialWorkflowView["records"][number]["record"]> = {},
) =>
  ({
    available: true,
    simulated: false,
    records: [
      {
        record: {
          id: "workflow",
          sessionId,
          status,
          goal: "PRIVATE GOAL",
          cwd: "PRIVATE PATH",
          ...details,
        },
      },
    ],
    ...(approval
      ? {
          approval: {
            id: "workflow",
            approvalId: "plan-approval",
            digest: approval,
          },
        }
      : {}),
  }) as OfficialWorkflowView;
it("deduplicates live permission waits, uses private fixed templates, and focuses the owning session", () => {
  const { n, host } = setup();
  n.event({ type: "turn", sessionId: "session", status: "running" });
  const event: UiEvent = {
    type: "permission_request",
    sessionId: "session",
    requestId: "approval",
    tool: "PRIVATE TOOL",
    summary: "PRIVATE CONTENT",
  };
  n.event(event);
  n.event(event);
  expect(host.show).toHaveBeenCalledTimes(1);
  expect(
    vi.mocked(host.show).mock.calls[0]!.slice(0, 2).join(" "),
  ).not.toContain("PRIVATE");
  vi.mocked(host.show).mock.calls[0]![2]();
  expect(host.focus).toHaveBeenCalledWith({
    type: "notification_focus",
    sessionId: "session",
    approvalId: "approval",
  });
});
it("does not notify old loaded approvals, terminal records, or unknown sessions", () => {
  const { n, host } = setup();
  n.workflow(view("approval", "old"));
  n.workflow(view("approval", "old"));
  n.event({ type: "turn", sessionId: "unknown", status: "running" });
  n.workflow(view("completed", undefined, "unknown"));
  expect(host.show).not.toHaveBeenCalled();
});
it("notifies new plan and operation waits once, then terminal once without duplicate turn idle", () => {
  const { n, host } = setup();
  n.workflow({ ...view("planning"), records: [] });
  n.event({ type: "turn", sessionId: "session", status: "running" });
  n.workflow(view("planning"));
  n.workflow(view("approval", "plan"));
  n.workflow(view("approval", "plan"));
  const operation = {
    ...view("implementing"),
    operationApproval: {
      workflowId: "workflow",
      approvalId: "operation",
      digest: "digest",
      command: "PRIVATE COMMAND",
    },
  } as OfficialWorkflowView;
  n.workflow(operation);
  n.workflow(operation);
  n.workflow(view("completed"));
  n.workflow(view("completed"));
  n.event({ type: "turn", sessionId: "session", status: "idle" });
  expect(host.show).toHaveBeenCalledTimes(3);
  expect(
    JSON.stringify(vi.mocked(host.show).mock.calls.map((c) => c.slice(0, 2))),
  ).not.toContain("PRIVATE");
  vi.mocked(host.show).mock.calls[1]![2]();
  expect(host.focus).toHaveBeenCalledWith({
    type: "notification_focus",
    sessionId: "session",
    workflowId: "workflow",
    approvalId: "operation",
  });
});
it("work classification is silent while preparation continues and preserves final turn notification", () => {
  const { n, host } = setup();
  n.workflow({ ...view("planning"), records: [] });
  n.event({ type: "turn", sessionId: "session", status: "running" });
  n.workflow(view("planning"));
  n.workflow(view("completed", undefined, "session", { inputIntent: "work" }));
  n.workflow(view("completed", undefined, "session", { inputIntent: "work" }));
  expect(host.show).not.toHaveBeenCalled();
  n.event({
    type: "turn",
    sessionId: "session",
    status: "idle",
    stopCause: "workflow_complete",
  });
  expect(host.show).toHaveBeenCalledTimes(1);
});
it("native work completion after classification notifies once", () => {
  const { n, host } = setup();
  n.workflow({ ...view("planning"), records: [] });
  n.event({ type: "turn", sessionId: "session", status: "running" });
  n.workflow(view("planning"));
  n.workflow(view("completed", undefined, "session", { inputIntent: "work" }));
  expect(host.show).not.toHaveBeenCalled();
  const nativeWork = {
    validation: "agent-reported",
    baseline: "files",
  } as const;
  n.workflow(view("planning", undefined, "session", { nativeWork }));
  n.workflow(view("completed", undefined, "session", { nativeWork }));
  n.event({ type: "turn", sessionId: "session", status: "idle" });
  expect(host.show).toHaveBeenCalledTimes(1);
  expect(vi.mocked(host.show).mock.calls[0]![1]).toContain("作業が終了");
});
it.each(["completed", "failed", "cancelled"])(
  "question completion or unsuccessful classification %s retains its terminal notification",
  (status) => {
    const { n, host } = setup();
    n.workflow({ ...view("planning"), records: [] });
    n.event({ type: "turn", sessionId: "session", status: "running" });
    n.workflow(view("planning"));
    n.workflow(
      view(status, undefined, "session", {
        inputIntent: status === "completed" ? "question" : "work",
      }),
    );
    n.event({ type: "turn", sessionId: "session", status: "idle" });
    expect(host.show).toHaveBeenCalledTimes(1);
  },
);
it("notifies each fresh live turn once and does not focus a deleted session", () => {
  const { n, host } = setup();
  for (let i = 0; i < 2; i++) {
    n.event({ type: "turn", sessionId: "session", status: "running" });
    n.event({ type: "turn", sessionId: "session", status: "idle" });
    n.event({ type: "turn", sessionId: "session", status: "idle" });
  }
  expect(host.show).toHaveBeenCalledTimes(2);
  n.event({ type: "state", state: { sessions: [] } } as unknown as UiEvent);
  vi.mocked(host.show).mock.calls[0]![2]();
  expect(host.focus).not.toHaveBeenCalled();
});
it("scope clearing is silent; actual input wait is not misreported as completion", () => {
  const { n, host } = setup();
  n.event({ type: "turn", sessionId: "session", status: "running" });
  n.event({ type: "official_scope_required", sessionId: "session" });
  expect(host.show).not.toHaveBeenCalled();
  n.event({
    type: "official_scope_required",
    sessionId: "session",
    text: "PRIVATE REQUEST",
  });
  n.event({
    type: "turn",
    sessionId: "session",
    status: "idle",
    stopCause: "awaiting_user",
  });
  expect(host.show).toHaveBeenCalledTimes(1);
  expect(vi.mocked(host.show).mock.calls[0]![1]).toContain("入力が必要");
});
it("manual read UI permission requests notify without a running model turn", () => {
  const { n, host } = setup();
  const request: UiEvent = {
    type: "permission_request",
    sessionId: "session",
    requestId: "read-only-ui",
    tool: "PRIVATE",
    summary: "PRIVATE",
  };
  n.event(request);
  n.event(request);
  expect(host.show).toHaveBeenCalledTimes(1);
});
it("a renewed plan approval with the same digest has its own notification identity", () => {
  const { n, host } = setup();
  n.workflow({ ...view("planning"), records: [] });
  const v = view("approval", "unchanged");
  n.workflow(v);
  n.workflow(v);
  n.workflow({ ...v, approval: { ...v.approval!, approvalId: "renewed" } });
  expect(host.show).toHaveBeenCalledTimes(2);
});
it("session errors followed by idle remain stopped, not successful", () => {
  const { n, host } = setup();
  n.event({ type: "turn", sessionId: "session", status: "running" });
  n.event({ type: "error", sessionId: "session", message: "PRIVATE ERROR" });
  n.event({ type: "turn", sessionId: "session", status: "idle" });
  expect(vi.mocked(host.show).mock.calls[0]![1]).toContain("停止");
});
it.each(["unsupported", "support-error", "show-error"])(
  "optional OS failure %s never blocks workflow",
  (mode) => {
    const { n, host } = setup();
    if (mode === "unsupported") host.supported = () => false;
    if (mode === "support-error")
      host.supported = () => {
        throw Error("unsupported");
      };
    if (mode === "show-error")
      host.show = () => {
        throw Error("OS error");
      };
    expect(() => {
      n.event({ type: "turn", sessionId: "session", status: "running" });
      n.event({ type: "turn", sessionId: "session", status: "idle" });
    }).not.toThrow();
  },
);
