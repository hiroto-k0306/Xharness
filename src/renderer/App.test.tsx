import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { mkdtemp, writeFile } from "node:fs/promises";
import image from "../../test/fixtures/images/pixel.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeProvider } from "../main/providers/fake/fake-provider.js";
import { SessionController } from "../main/session/controller.js";
import { type Tool } from "../main/tools/registry.js";
import { lifecycleTools } from "../main/tools/lifecycle.js";
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

async function setup(provider = new FakeProvider(), config?: string) {
  // テストごとに独立した配線にする(前のテストの遅れたイベントを混ぜない)
  const bus: { listener?: (e: UiEvent) => void } = {};
  const home = await mkdtemp(join(tmpdir(), "xh-app-"));
  if (config) await writeFile(join(home, "config.yaml"), config);
  const folder = await mkdtemp(join(tmpdir(), "xh-folder-"));
  controller = new SessionController({
    provider,
    model: "fake",
    home,
    fake: true,
    version: "0.0.1",
    host: { pickFolder: async () => folder },
    // Electron のイベントチャネルは invoke の返答と独立して届く。
    // new_session の空の transcript が返答より後に届く順序も再現する。
    emit: (e) => {
      setTimeout(() => act(() => bus.listener?.(e)), 0);
    },
    createTools: () => new Map([...lifecycleTools(), ["Read", readTool]]),
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
      heroOpen: true,
      sidebarOpen: true,
      collapsed: {},
      sort: "recent",
      search: "",
      pickerOpen: false,
    },
  });
}
beforeEach(() => setup());

describe("App wired to the real SessionController", () => {
  it("requires confirmation to delete a session and removes its history through the controller", async () => {
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "hello{Enter}");
    await screen.findByText("pong");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
    const id = useStore.getState().app!.currentSessionId!;
    await userEvent.click(
      screen.getByRole("button", { name: "helloのセッションを削除" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(useStore.getState().app!.sessions.some((s) => s.id === id)).toBe(
      true,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "helloのセッションを削除" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() =>
      expect(useStore.getState().app!.sessions.some((s) => s.id === id)).toBe(
        false,
      ),
    );
    expect(useStore.getState().views[id]).toBeUndefined();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("warns when saved session images exceed the configured threshold without blocking", async () => {
    await setup(
      new FakeProvider(),
      "images: {maxPerMessage: 2, warnSessionBytes: 1}",
    );
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "hello{Enter}");
    await screen.findByText("pong");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
    await act(async () => {
      expect(
        await window.harness.command({
          type: "send",
          sessionId: useStore.getState().app!.currentSessionId!,
          text: "",
          images: [image],
        }),
      ).toMatchObject({ ok: true });
    });
    expect(
      await screen.findByText(/セッションの画像合計が警告値/),
    ).toHaveTextContent("/compact");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
  });
  it("answers AskUserQuestion through the normal send command and provider history", async () => {
    const requests: string[] = [];
    await setup(
      new FakeProvider({
        script: [
          {
            type: "message",
            stopReason: "tool_use",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "q",
                  name: "AskUserQuestion",
                  input: {
                    question: "どちらで進めますか？",
                    options: ["修正する", "調査する"],
                  },
                },
              ],
            },
          },
        ],
        onRequest: (request) => {
          requests.push(
            request.messages
              .at(-1)!
              .content.flatMap((b) => (b.type === "text" ? [b.text] : []))
              .join("\n"),
          );
        },
      }),
    );
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "質問して{Enter}");
    const button = await screen.findByRole("button", { name: "1. 修正する" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(
      await within(screen.getByTestId("transcript")).findByText("修正する"),
    ).toBeInTheDocument();
    expect(await screen.findByText("pong")).toBeInTheDocument();
    expect(requests).toEqual(["質問して", "修正する"]);
    expect(button).toBeDisabled();
  });
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
    await userEvent.click(
      await screen.findByRole("button", { name: /^first(?: |$)/ }),
    );
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
    expect(
      screen.getByRole("button", { name: /^first(?: |$)/ }),
    ).not.toHaveAttribute("aria-current", "true");
  });
  it("keeps the message in the input and shows one notice when the session folder is gone", async () => {
    const { rm } = await import("node:fs/promises");
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "first{Enter}");
    await screen.findByText("pong");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
    const cwd = useStore.getState().app!.sessions[0]!.cwd;
    await rm(cwd, { recursive: true, force: true });
    await userEvent.type(screen.getByLabelText("prompt"), "second{Enter}");
    await waitFor(() =>
      expect(screen.getByLabelText("prompt")).toHaveValue("second"),
    );
    const notices = screen.getAllByText(/作業フォルダが見つかりません/);
    expect(notices).toHaveLength(1);
    expect(screen.queryByText(/Working directory not found/)).toBeNull();
  });
});
