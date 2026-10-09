import { act, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "../main/session/controller.js";
import { FakeProvider } from "../main/providers/fake/fake-provider.js";
import { parseCommand, type HarnessApi, type UiEvent } from "../shared/ipc.js";
import type { OfficialSessionSubmission } from "../shared/official-session.js";
import { App } from "./App.js";
import { useStore } from "./state/store.js";
let controller: SessionController;
afterEach(async () => {
  await controller?.shutdown();
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "xh-official-ui-home-")),
    cwd = await mkdtemp(join(tmpdir(), "xh-official-ui-project-"));
  const listeners = new Set<(e: UiEvent) => void>();
  const native = vi.fn(async (request: OfficialSessionSubmission) => ({
    summary: "公式の有限回答",
    workflowId: `ui-native-${request.sessionId}`,
    status: "completed",
    taskRequired:
      !request.task && !request.automaticWork && /変更|修正/.test(request.text),
  }));
  const legacy = new FakeProvider(),
    oldStream = vi.spyOn(legacy, "stream");
  controller = new SessionController({
    home,
    model: "claude:opus",
    fake: true,
    version: "test",
    provider: legacy,
    officialSession: native,
    host: { pickFolder: async () => cwd },
    emit: (e) =>
      queueMicrotask(() =>
        act(() => {
          for (const listener of listeners) listener(e);
        }),
      ),
  });
  await controller.init();
  const api: HarnessApi = {
    async command(c) {
      const parsed = parseCommand(JSON.parse(JSON.stringify(c)));
      return parsed
        ? controller.handle(parsed)
        : { ok: false, error: "Invalid command" };
    },
    onEvent(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    async officialWorkflow() {
      return {
        available: true,
        storageReady: true,
        simulated: true,
        records: [],
      };
    },
  };
  window.harness = api;
  useStore.setState({
    app: null,
    views: {},
    prefs: {
      heroOpen: true,
      sidebarOpen: true,
      collapsed: {},
      sort: "recent",
      search: "",
      pickerOpen: false,
    },
  });
  return { cwd, native, oldStream };
}
it("ordinary UI questions use the official bridge and return to idle without a planning loop", async () => {
  const { native, oldStream } = await setup();
  render(<App />);
  await screen.findByText("+ new session");
  expect(screen.queryByRole("combobox", { name: "公式入力の種類" })).toBeNull();
  await userEvent.type(screen.getByLabelText("prompt"), "質問です{Enter}");
  await screen.findByText("公式の有限回答");
  await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
  expect(native).toHaveBeenCalledTimes(1);
  expect(native.mock.calls[0]![0].task).toBeUndefined();
  expect(oldStream).not.toHaveBeenCalled();
});
it("official UI keeps legacy stage history readable and disables its operations and slash suggestions", async () => {
  const { native, oldStream } = await setup();
  render(<App />);
  await screen.findByText("+ new session");
  await userEvent.type(screen.getByLabelText("prompt"), "質問です{Enter}");
  await screen.findByText("公式の有限回答");
  await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
  const sessionId = useStore.getState().app!.currentSessionId!;
  act(() => {
    useStore.getState().apply({
      type: "workflow",
      sessionId,
      phase: "implement",
      reviewRound: 0,
      items: [{ id: "saved-task", status: "integrated" }],
      findings: [],
    });
  });
  expect(screen.getByRole("navigation", { name: "タスク段階" })).toBeVisible();
  expect(screen.queryByLabelText("段階の操作")).toBeNull();
  expect(
    screen.getByText(/旧workflow段階の変更は公式経路に未対応/),
  ).toBeVisible();
  expect(
    screen.getByText(/選択中のフォルダーを探索して計画を提案/),
  ).toBeVisible();
  await userEvent.type(screen.getByLabelText("prompt"), "/");
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option")).toHaveTextContent("/stop");
  await userEvent.clear(screen.getByLabelText("prompt"));
  await userEvent.type(screen.getByLabelText("prompt"), "/stop{Enter}");
  await screen.findByText(
    /停止しました。再開するときは新しい指示を入力してください。/,
  );
  expect(native).toHaveBeenCalledTimes(1);
  expect(oldStream).not.toHaveBeenCalled();
});
it("ordinary LoopFlow uses workflow state and hides the legacy six-step tabs", async () => {
  await setup();
  render(<App />);
  await screen.findByText("+ new session");
  act(() => {
    useStore.setState((state) => ({
      app: state.app ? { ...state.app, phase4: true } : null,
    }));
  });
  await userEvent.click(screen.getByRole("tab", { name: "LoopFlow" }));
  expect(
    screen.getByRole("complementary", { name: "通常ワークフロー" }),
  ).toBeInTheDocument();
  expect(screen.queryByTestId("step-model")).toBeNull();
  expect(
    screen.queryByRole("complementary", { name: "agent loop" }),
  ).toBeNull();
});
it("a legacy scope notice cannot prepare work without a selected folder", async () => {
  const { native, oldStream } = await setup();
  render(<App />);
  await screen.findByText("+ new session");
  await userEvent.type(screen.getByLabelText("prompt"), "変更して{Enter}");
  const confirm = await screen.findByRole("button", {
    name: "作業対象を自動確認して計画を作成",
  });
  await waitFor(() => expect(confirm).toBeEnabled());
  await userEvent.click(confirm);
  await screen.findByText(/対象フォルダーを選択してください/);
  expect(native).toHaveBeenCalledTimes(1);
  expect(native.mock.calls[0]![0].task).toBeUndefined();
  expect(oldStream).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText("prompt"), "質問です{Enter}");
  await waitFor(() => expect(native).toHaveBeenCalledTimes(2));
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "作業対象を自動確認して計画を作成",
      }),
    ).toBeNull(),
  );
});
it("work uses the original request and selected directory with automatic discovery and no manual scope fields", async () => {
  const { cwd, native, oldStream } = await setup();
  render(<App />);
  await screen.findByText("+ new session");
  await userEvent.click(screen.getByRole("button", { name: /no workspace/ }));
  await userEvent.click(
    await screen.findByRole("button", { name: /open folder/ }),
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /start session in/ }),
  );
  await waitFor(() =>
    expect(
      useStore
        .getState()
        .app?.sessions.find(
          (s) => s.id === useStore.getState().app?.currentSessionId,
        )?.cwd,
    ).toBe(cwd),
  );
  await userEvent.type(screen.getByLabelText("prompt"), "加算を修正{Enter}");
  await waitFor(() => expect(native).toHaveBeenCalledTimes(1));
  expect(native.mock.calls[0]![0]).toMatchObject({
    cwd,
    text: "加算を修正",
    automaticWork: true,
  });
  expect(native.mock.calls[0]![0].task).toBeUndefined();
  expect(screen.queryByLabelText("公式作業の変更対象")).toBeNull();
  expect(screen.queryByLabelText("公式作業の独立テスト")).toBeNull();
  expect(oldStream).not.toHaveBeenCalled();
});
