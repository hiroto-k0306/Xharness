import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeProvider } from "../main/providers/fake/fake-provider.js";
import { SessionController } from "../main/session/controller.js";
import { type Tool } from "../main/tools/registry.js";
import { parseCommand, type HarnessApi, type UiEvent } from "../shared/ipc.js";
import { App } from "./App.js";
import { useStore } from "./state/store.js";

// main の SessionController をそのまま使い、IPC の代わりにメモリ内で繋ぐ。
// parseCommand を必ず通すので、実際の IPC と同じ検証を受ける。
const readTool: Tool = {
  spec: { name: "Read", description: "Read", inputSchema: {} },
  readOnly: true,
  validate: async () => undefined,
  execute: async () => ({ content: "file body" }),
};
let controller: SessionController;

beforeEach(async () => {
  // テストごとに独立した配線にする(前のテストの遅れたイベントを混ぜない)
  const bus: { listener?: (e: UiEvent) => void } = {};
  const home = await mkdtemp(join(tmpdir(), "xh-app-"));
  const folder = await mkdtemp(join(tmpdir(), "xh-folder-"));
  controller = new SessionController({
    provider: new FakeProvider(),
    model: "fake",
    home,
    fake: true,
    version: "0.0.1",
    host: { pickFolder: async () => folder },
    emit: (e) => act(() => bus.listener?.(e)),
    createTools: () => new Map([["Read", readTool]]),
  });
  await controller.init();
  const api: HarnessApi = {
    async command(c) {
      const parsed = parseCommand(JSON.parse(JSON.stringify(c)));
      if (!parsed) return { ok: false, error: "Invalid command" };
      return controller.handle(parsed);
    },
    onEvent(l) {
      bus.listener = l;
      return () => (bus.listener = undefined);
    },
  };
  window.harness = api;
  useStore.setState({
    app: null,
    views: {},
    prefs: {
      sidebarOpen: true,
      collapsed: {},
      sort: "recent",
      search: "",
      pickerOpen: false,
    },
  });
});

describe("App wired to the real SessionController", () => {
  it("boots, creates a session on first send, streams a reply", async () => {
    render(<App />);
    expect(await screen.findByText("+ new session")).toBeInTheDocument();
    expect(screen.getByText("FAKE")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("prompt"), "hello{Enter}");
    expect(await screen.findByText("pong")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("transcript")).getByText("hello"),
    ).toBeInTheDocument();
    // サイドバーに「その他」グループとタイトルが出る
    expect(screen.getByTestId("group-other")).toHaveTextContent("hello");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
  });
  it("asks inline for a tool call and continues after pressing y", async () => {
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "read a.txt{Enter}");
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Read");
    expect(screen.getByTestId("step-gate")).toHaveAttribute(
      "data-state",
      "waiting",
    );
    expect(screen.getByLabelText("prompt")).toBeDisabled();
    await userEvent.keyboard("y");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("pong")).toBeInTheDocument();
    expect(document.querySelector("[data-status='ok']")).not.toBeNull();
  });
  it("denies with n and shows the card as denied", async () => {
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "read a.txt{Enter}");
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("n");
    await waitFor(() =>
      expect(document.querySelector("[data-status='denied']")).not.toBeNull(),
    );
  });
  it("Esc interrupts a running turn", async () => {
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "slow one{Enter}");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeDisabled());
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByText("# 中断しました")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
  });
  it("opens a folder through the picker and starts a session there", async () => {
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
      expect(screen.getByTestId("titlebar")).not.toHaveTextContent(
        "no workspace",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("switches between sessions and keeps their transcripts apart", async () => {
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "first{Enter}");
    await screen.findByText("pong");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: /new session/ }));
    await waitFor(() => expect(screen.queryByText("pong")).toBeNull());
    await userEvent.click(await screen.findByRole("button", { name: /first/ }));
    expect(await screen.findByText("pong")).toBeInTheDocument();
  });
  it("Ctrl+B hides the sidebar and the choice is remembered", async () => {
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(screen.queryByText("+ new session")).toBeNull();
    expect(JSON.parse(localStorage.getItem("xharness.prefs")!)).toMatchObject({
      sidebarOpen: false,
    });
  });
  it("Ctrl+W closes the current session but keeps it in the list", async () => {
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "first{Enter}");
    await screen.findByText("pong");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
    await userEvent.keyboard("{Control>}w{/Control}");
    await waitFor(() => expect(screen.queryByText("pong")).toBeNull());
    expect(screen.getByRole("button", { name: /first/ })).not.toHaveAttribute(
      "aria-current",
      "true",
    );
  });
});
