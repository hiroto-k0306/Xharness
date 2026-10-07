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
  expect(screen.getByRole("combobox", { name: "公式入力の種類" })).toHaveValue(
    "question",
  );
  await userEvent.type(screen.getByLabelText("prompt"), "質問です{Enter}");
  await screen.findByText("公式の有限回答");
  await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
  expect(native).toHaveBeenCalledTimes(1);
  expect(native.mock.calls[0]![0].task).toBeUndefined();
  expect(oldStream).not.toHaveBeenCalled();
});
it("UI keeps incomplete work requests as drafts and never converts them into questions", async () => {
  const { native, oldStream } = await setup();
  render(<App />);
  await screen.findByText("+ new session");
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "公式入力の種類" }),
    "work",
  );
  expect(
    screen.getByText(/既存worktreeの有無や完了時の反映操作は従来どおり/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/独立コピー/)).toBeNull();
  await userEvent.type(screen.getByLabelText("prompt"), "変更して{Enter}");
  await screen.findByText(
    /プロジェクト、変更対象、既存の独立テストを指定してください/,
  );
  expect(screen.getByLabelText("prompt")).toHaveValue("変更して");
  expect(native).not.toHaveBeenCalled();
  expect(oldStream).not.toHaveBeenCalled();
});
it("UI submits explicit scope using the selected session directory and opens the approval panel", async () => {
  const { cwd, native, oldStream } = await setup();
  render(<App />);
  await screen.findByText("+ new session");
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "公式入力の種類" }),
    "work",
  );
  await userEvent.type(
    screen.getByLabelText("公式作業の変更対象"),
    "prior-session.mjs",
  );
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
  expect(screen.getByRole("combobox", { name: "公式入力の種類" })).toHaveValue(
    "work",
  );
  expect(screen.getByLabelText("公式作業の変更対象")).toHaveValue("");
  await userEvent.selectOptions(
    screen.getByRole("combobox", { name: "公式入力の種類" }),
    "work",
  );
  await userEvent.type(screen.getByLabelText("公式作業の変更対象"), "add.mjs");
  await userEvent.type(
    screen.getByLabelText("公式作業の独立テスト"),
    "acceptance.test.mjs",
  );
  await userEvent.type(screen.getByLabelText("prompt"), "加算を修正{Enter}");
  await waitFor(() => expect(native).toHaveBeenCalledTimes(1));
  await screen.findByText("公式の有限回答");
  expect(native).toHaveBeenCalledTimes(1);
  expect(native.mock.calls[0]![0]).toMatchObject({
    cwd,
    text: "加算を修正",
    task: { files: ["add.mjs"], testFile: "acceptance.test.mjs" },
  });
  expect(screen.getByLabelText("公式単一タスクworkflow")).toBeInTheDocument();
  expect(oldStream).not.toHaveBeenCalled();
});
