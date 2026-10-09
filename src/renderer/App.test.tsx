import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { mkdtemp, writeFile } from "node:fs/promises";
import image from "../../test/fixtures/images/pixel.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../main/session/controller.js";
import { FakeProvider } from "../main/providers/fake/fake-provider.js";
import {
  parseCommand,
  type HarnessApi,
  type UiEvent,
  type TranscriptItem,
} from "../shared/ipc.js";
import { App } from "./App.js";
import { useStore } from "./state/store.js";

// main の SessionController をそのまま使い、IPC の代わりにメモリ内で繋ぐ。
// parseCommand を必ず通すので、実際の IPC と同じ検証を受ける。
type OfficialBridge = NonNullable<
  ConstructorParameters<typeof SessionController>[0]["officialSession"]
>;
let controller: SessionController;
let fixtureProvider: FakeProvider;
const completed = () => ({
  workflowId: "app-official-fixture",
  status: "completed",
  intent: "question" as const,
  summary: "pong",
  taskRequired: false,
});

async function setup(
  bridge: OfficialBridge = vi.fn(async () => completed()),
  config?: string,
  savedItems: TranscriptItem[] = [],
) {
  await controller?.shutdown();
  // テストごとに独立した配線にする(前のテストの遅れたイベントを混ぜない)
  const listeners = new Set<(e: UiEvent) => void>();
  const home = await mkdtemp(join(tmpdir(), "xh-app-"));
  if (config) await writeFile(join(home, "config.yaml"), config);
  const folder = await mkdtemp(join(tmpdir(), "xh-folder-"));
  // 互換状態のモデル情報だけに使い、旧HTTP/独自ループが呼ばれたら失敗させる。
  fixtureProvider = new FakeProvider();
  vi.spyOn(fixtureProvider, "stream").mockImplementation(() => {
    throw new Error("Legacy model execution is unavailable in this fixture");
  });
  controller = new SessionController({
    provider: fixtureProvider,
    model: "claude:opus",
    officialSession: bridge,
    home,
    fake: true,
    version: "0.0.1",
    host: { pickFolder: async () => folder },
    // Electron のイベントチャネルは invoke の返答と独立して届く。
    // new_session の空の transcript が返答より後に届く順序も再現する。
    emit: (e) => {
      setTimeout(
        () =>
          act(() => {
            for (const listener of listeners)
              listener(
                e.type === "transcript"
                  ? { ...e, items: [...savedItems, ...e.items] }
                  : e,
              );
          }),
        0,
      );
    },
  });
  await controller.init();
  const api: HarnessApi = {
    async command(c) {
      const parsed = parseCommand(JSON.parse(JSON.stringify(c)));
      if (!parsed) return { ok: false, error: "Invalid command" };
      return controller.handle(parsed);
    },
    onEvent(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
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
}
beforeEach(() => setup());
afterEach(async () => {
  await controller?.shutdown();
  expect(fixtureProvider.stream).not.toHaveBeenCalled();
});

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
    await setup(undefined, "images: {maxPerMessage: 2, warnSessionBytes: 1}");
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "hello{Enter}");
    await screen.findByText("pong");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
    const id = useStore.getState().app!.currentSessionId!;
    // 保存済み旧画像の表示fixture。公式モデルへの画像送信は行わない。
    act(() => {
      useStore.setState((state) => ({
        app: state.app
          ? {
              ...state.app,
              sessions: state.app.sessions.map((session) =>
                session.id === id ? { ...session, imageBytes: 2 } : session,
              ),
            }
          : null,
      }));
    });
    expect(
      await screen.findByText(/セッションの画像合計が警告値/),
    ).toHaveTextContent("旧 /compact に未対応");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
  });
  it("keeps image zoom focused when a running turn completes without typing into the prompt", async () => {
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    // 保存画像の閲覧中に公式テキスト応答が終了するUI遷移を再現する。
    await setup(
      async () => {
        await ready;
        return completed();
      },
      undefined,
      [{ kind: "user", id: "saved-image", text: "保存画像", images: [image] }],
    );
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.click(screen.getByRole("button", { name: /new session/ }));
    await waitFor(() =>
      expect(useStore.getState().app!.currentSessionId).toBeTruthy(),
    );
    const id = useStore.getState().app!.currentSessionId!;
    const prompt = screen.getByLabelText("prompt");
    await userEvent.type(prompt, "draft");
    try {
      await act(async () => {
        expect(
          await window.harness.command({
            type: "send",
            sessionId: id,
            text: "see",
          }),
        ).toMatchObject({ ok: true });
      });
      const thumb = await screen.findByRole("button", {
        name: "添付画像 1 を拡大",
      });
      await waitFor(() => expect(prompt).toBeDisabled());
      await userEvent.click(thumb);
      const close = screen.getByRole("button", { name: "閉じる" });
      expect(close).toHaveFocus();
      finish();
      await screen.findByText("pong");
      await waitFor(() => expect(prompt).toBeEnabled());
      expect(close).toHaveFocus();
      expect(
        screen.getByRole("dialog", { name: "画像の拡大表示" }),
      ).toBeInTheDocument();
      await userEvent.keyboard("abc");
      expect(prompt).toHaveValue("draft");
      expect(close).toHaveFocus();
      await userEvent.keyboard("{Enter}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(thumb).toHaveFocus();
      expect(
        useStore.getState().views[id]!.items.filter((i) => i.kind === "user"),
      ).toHaveLength(2);
      expect(prompt).toHaveValue("draft");
      await userEvent.clear(prompt);
      await userEvent.type(prompt, "after");
      expect(prompt).toHaveValue("after");
    } finally {
      finish();
    }
  });
  it("keeps superseded saved question choices readable and accepts a new official text reply", async () => {
    const requests: string[] = [];
    await setup(
      async (request) => {
        requests.push(request.text);
        return completed();
      },
      undefined,
      [
        {
          kind: "tool",
          id: "saved-question",
          tool: "AskUserQuestion",
          summary: "保存された質問",
          status: "ok",
          question: {
            question: "どちらで進めますか？",
            options: ["修正する", "調査する"],
          },
        },
      ],
    );
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "質問して{Enter}");
    await screen.findByText("pong");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
    const button = await screen.findByRole("button", { name: "1. 修正する" });
    expect(button).toBeDisabled();
    expect(screen.getByText("どちらで進めますか？")).toBeVisible();
    await userEvent.type(screen.getByLabelText("prompt"), "修正する{Enter}");
    await waitFor(() =>
      expect(
        within(screen.getByTestId("transcript")).getByText("修正する"),
      ).toBeInTheDocument(),
    );
    await waitFor(() => expect(requests).toEqual(["質問して", "修正する"]));
    expect(requests).toEqual(["質問して", "修正する"]);
    expect(button).toBeDisabled();
  });
  it("boots, creates a session on first send and receives an official reply", async () => {
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
  // 旧Readのy/n許可は廃止した独自ToolRegistryの契約。公式操作の承認は
  // OfficialWorkflowPanel.test.tsxと公式serviceの境界テストで検証する。
  it("refuses direct image sends through the official controller without dispatch", async () => {
    const bridge = vi.fn(async () => completed());
    await setup(bridge);
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.click(screen.getByRole("button", { name: /new session/ }));
    await waitFor(() =>
      expect(useStore.getState().app!.currentSessionId).toBeTruthy(),
    );
    const result = await window.harness.command({
      type: "send",
      sessionId: useStore.getState().app!.currentSessionId!,
      text: "see",
      images: [image],
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("画像");
    expect(bridge).not.toHaveBeenCalled();
  });
  it("Esc does not stop a turn; the button immediately left of the model picker does", async () => {
    await setup(async (_request, signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return completed();
    });
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "slow one{Enter}");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeDisabled());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByText("# 中断しました")).toBeNull();
    expect(screen.getByLabelText("prompt")).toBeDisabled();
    const stop = screen.getByRole("button", { name: "停止" });
    expect(stop.nextElementSibling).toBe(
      screen.getByRole("button", { name: "モデル切替" }),
    );
    await userEvent.click(stop);
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
  // フォルダー存在の事前選別は旧HTTP契約。現在の公式サービスが実行時に検査する。
  // 送信拒否でdraftを戻し単一理由を表示するUI契約は、現役の入力上限で保護する。
  it("keeps rejected official text in the input and displays one reason", async () => {
    render(<App />);
    await screen.findByText("+ new session");
    await userEvent.type(screen.getByLabelText("prompt"), "first{Enter}");
    await screen.findByText("pong");
    await waitFor(() => expect(screen.getByLabelText("prompt")).toBeEnabled());
    const text = "x".repeat(4001);
    fireEvent.change(screen.getByLabelText("prompt"), {
      target: { value: text },
    });
    fireEvent.keyDown(screen.getByLabelText("prompt"), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByLabelText("prompt")).toHaveValue(text),
    );
    expect(screen.getAllByText(/公式経路の入力は1〜4000文字/)).toHaveLength(1);
  });
});
