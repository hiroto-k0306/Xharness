import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PermissionInline } from "./PermissionInline.js";
import { PromptLine } from "./PromptLine.js";
import { Sidebar, type SidebarProps } from "./Sidebar.js";
import { StepTabs } from "./StepTabs.js";
import { TitleBar } from "./TitleBar.js";
import { Transcript } from "./Transcript.js";
import { WorkspacePicker } from "./WorkspacePicker.js";

describe("TitleBar", () => {
  it("shows the logo, workspace + branch, and the fake badge", async () => {
    const toggle = vi.fn();
    render(
      <TitleBar
        workspaceName="myapp"
        branch="main"
        pickerOpen={false}
        onTogglePicker={toggle}
        fake
      />,
    );
    expect(screen.getByText("XHARNESS")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /myapp/ })).toHaveTextContent(
      "⎇ main",
    );
    expect(screen.getByText("FAKE")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /myapp/ }));
    expect(toggle).toHaveBeenCalled();
  });
  it("falls back to 'no workspace' and has no fake badge", () => {
    render(<TitleBar pickerOpen onTogglePicker={() => {}} fake={false} />);
    expect(screen.getByText("no workspace")).toBeInTheDocument();
    expect(screen.queryByText("FAKE")).toBeNull();
    expect(
      screen.getByRole("button", { name: /no workspace/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

describe("StepTabs", () => {
  it("marks the running step, earlier ones done, later ones idle", () => {
    render(
      <StepTabs
        active={{ step: 3, node: "tool_use", round: 4 }}
        waiting={false}
        model="claude-opus-5-5"
      />,
    );
    expect(screen.getByTestId("step-context")).toHaveAttribute(
      "data-state",
      "done",
    );
    expect(screen.getByTestId("step-tool_use")).toHaveAttribute(
      "data-state",
      "running",
    );
    expect(screen.getByTestId("step-tool_use")).toHaveClass("running");
    expect(screen.getByTestId("step-act")).toHaveAttribute(
      "data-state",
      "idle",
    );
    expect(screen.getByText("4")).toBeInTheDocument(); // loop 4
  });
  it("stops spinning and waits (warn) while the gate asks for permission", () => {
    render(
      <StepTabs
        active={{ step: 4, node: "gate", round: 1 }}
        waiting
        model="fake"
      />,
    );
    const gate = screen.getByTestId("step-gate");
    expect(gate).toHaveAttribute("data-state", "waiting");
    expect(gate).toHaveClass("waiting");
    expect(gate).not.toHaveClass("running");
    expect(gate.style.getPropertyValue("--glow")).toBe("var(--warn)");
  });
  it("uses the role color: model → provider, act → tool", () => {
    const { rerender } = render(
      <StepTabs
        active={{ step: 2, node: "model", round: 1 }}
        waiting={false}
        model="gpt-6.1-sol"
      />,
    );
    expect(
      screen.getByTestId("step-model").style.getPropertyValue("--glow"),
    ).toBe("var(--codex)");
    rerender(
      <StepTabs
        active={{ step: 5, node: "act", round: 1 }}
        waiting={false}
        model="gpt-6.1-sol"
      />,
    );
    expect(
      screen.getByTestId("step-act").style.getPropertyValue("--glow"),
    ).toBe("var(--tool)");
  });
  it("shows idle with no running step", () => {
    render(<StepTabs waiting={false} model="fake" />);
    expect(screen.getByText("idle")).toBeInTheDocument();
    for (const t of screen.getAllByTestId(/step-/))
      expect(t).toHaveAttribute("data-state", "idle");
  });
});

describe("Transcript", () => {
  it("renders model output as text, never as HTML", () => {
    render(
      <Transcript
        running={false}
        model="fake"
        items={[
          {
            kind: "assistant",
            id: "m",
            text: '<img src=x onerror="alert(1)"><script>bad()</script>',
          },
        ]}
      />,
    );
    expect(document.querySelector("img[src='x']")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/<script>bad\(\)<\/script>/)).toBeInTheDocument();
  });
  it("shows user turns, tool cards with their status, and notices", () => {
    render(
      <Transcript
        running
        model="fake"
        items={[
          { kind: "user", id: "u", text: "hello" },
          {
            kind: "tool",
            id: "#0001",
            tool: "Read",
            summary: "Read a.txt",
            status: "pending",
          },
          {
            kind: "tool",
            id: "#0002",
            tool: "Write",
            summary: "Write b",
            status: "denied",
          },
          {
            kind: "tool",
            id: "#0003",
            tool: "Read",
            summary: "Read c",
            status: "ok",
          },
          { kind: "notice", id: "n", tone: "err", text: "枠の上限" },
        ]}
      />,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    const cards = screen
      .getByTestId("transcript")
      .querySelectorAll("[data-status]");
    expect([...cards].map((c) => c.getAttribute("data-status"))).toEqual([
      "pending",
      "denied",
      "ok",
    ]);
    expect(screen.getByText("# 枠の上限")).toBeInTheDocument();
  });
  it("shows the logo and tagline when empty", () => {
    render(<Transcript items={[]} running={false} model="fake" />);
    expect(screen.getByText("HARNESS")).toBeInTheDocument();
    expect(screen.getByText(/decides/)).toBeInTheDocument();
  });
});

describe("PromptLine", () => {
  const base = {
    cwdLabel: "myapp",
    running: false,
    blocked: false,
    modelLabel: "fake",
    modelColor: "var(--claude)",
  };
  it("sends on Enter, keeps Shift+Enter as a newline, and ignores empty input", async () => {
    const onSubmit = vi.fn();
    render(<PromptLine {...base} onSubmit={onSubmit} />);
    const box = screen.getByLabelText("prompt");
    await userEvent.type(box, "{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(box).toHaveValue("line1\nline2");
    await userEvent.type(box, "{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("line1\nline2");
    expect(box).toHaveValue("");
  });
  it("does not send the Enter that confirms Japanese IME composition", () => {
    const onSubmit = vi.fn();
    render(<PromptLine {...base} onSubmit={onSubmit} />);
    const box = screen.getByLabelText("prompt");
    fireEvent.change(box, { target: { value: "こんにちは" } });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true, keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("こんにちは");
  });
  it("is disabled while running or waiting for permission", () => {
    const { rerender } = render(
      <PromptLine {...base} running onSubmit={() => {}} />,
    );
    expect(screen.getByLabelText("prompt")).toBeDisabled();
    expect(screen.getByLabelText("prompt")).toHaveAttribute(
      "placeholder",
      expect.stringContaining("Esc"),
    );
    rerender(<PromptLine {...base} blocked onSubmit={() => {}} />);
    expect(screen.getByLabelText("prompt")).toBeDisabled();
  });
  it("shows the workspace prompt and model chip", () => {
    render(<PromptLine {...base} onSubmit={() => {}} />);
    expect(screen.getByText("myapp")).toBeInTheDocument();
    expect(screen.getByText("❯")).toBeInTheDocument();
    expect(screen.getByText("fake")).toBeInTheDocument();
  });
});

describe("PermissionInline", () => {
  it("answers with y / a / n keys and Escape (deny)", async () => {
    const onRespond = vi.fn();
    render(
      <PermissionInline tool="Bash" summary="Bash ls" onRespond={onRespond} />,
    );
    await userEvent.keyboard("y");
    await userEvent.keyboard("a");
    await userEvent.keyboard("n");
    await userEvent.keyboard("{Escape}");
    expect(onRespond.mock.calls.map((c) => c[0])).toEqual([
      "allow",
      "always",
      "deny",
      "deny",
    ]);
  });
  it("ignores other keys and shortcuts with modifiers", async () => {
    const onRespond = vi.fn();
    render(
      <PermissionInline tool="Bash" summary="Bash ls" onRespond={onRespond} />,
    );
    await userEvent.keyboard("x");
    await userEvent.keyboard("{Control>}y{/Control}");
    expect(onRespond).not.toHaveBeenCalled();
  });
  it("shows the summary and supports clicking the buttons", async () => {
    const onRespond = vi.fn();
    render(
      <PermissionInline
        tool="Write"
        summary='Write {"path":"a"}'
        onRespond={onRespond}
      />,
    );
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      'Write {"path":"a"}',
    );
    await userEvent.click(screen.getByRole("button", { name: /allow/ }));
    await userEvent.click(screen.getByRole("button", { name: /session/ }));
    await userEvent.click(screen.getByRole("button", { name: /deny/ }));
    expect(onRespond.mock.calls.map((c) => c[0])).toEqual([
      "allow",
      "always",
      "deny",
    ]);
  });
  it("stops listening after unmount", async () => {
    const onRespond = vi.fn();
    const { unmount } = render(
      <PermissionInline tool="t" summary="s" onRespond={onRespond} />,
    );
    unmount();
    await userEvent.keyboard("y");
    expect(onRespond).not.toHaveBeenCalled();
  });
});

const sidebarProps = (over: Partial<SidebarProps> = {}): SidebarProps => ({
  app: {
    currentSessionId: "s1",
    model: "fake",
    version: "0.1.0",
    workspaces: [
      {
        id: "w1",
        root: "/dev/myapp",
        name: "myapp",
        kind: "git",
        branch: "main",
        lastOpenedAt: 1,
      },
    ],
    sessions: [
      {
        id: "s1",
        title: "ログイン追加",
        workspaceId: "w1",
        cwd: "/dev/myapp",
        readOnly: false,
        model: "fake",
        effort: "high",
        createdAt: 0,
        updatedAt: Date.now(),
        status: "running",
        providers: ["claude"],
        branch: "main",
      },
      {
        id: "s2",
        title: "雑談",
        workspaceId: null,
        cwd: "/s",
        readOnly: false,
        model: "fake",
        effort: "high",
        createdAt: 0,
        updatedAt: Date.now() - 7_200_000,
        status: "ask",
        providers: [],
      },
    ],
  },
  views: {},
  collapsed: {},
  sort: "recent",
  search: "",
  onNew: () => {},
  onOpen: () => {},
  onToggleGroup: () => {},
  onSearch: () => {},
  onSort: () => {},
  ...over,
});
describe("Sidebar", () => {
  it("groups by workspace and puts 'その他' last, with path, kind and branch", () => {
    render(<Sidebar {...sidebarProps()} />);
    const groups = screen.getAllByTestId(/^group-/);
    expect(groups.map((g) => g.getAttribute("data-testid"))).toEqual([
      "group-w1",
      "group-other",
    ]);
    expect(
      within(groups[0]!).getByText("/dev/myapp · git"),
    ).toBeInTheDocument();
    expect(within(groups[0]!).getByText("⎇ main")).toBeInTheDocument();
    expect(within(groups[1]!).getByText("その他")).toBeInTheDocument();
  });
  it("shows running / ask state and marks the current session", () => {
    render(<Sidebar {...sidebarProps()} />);
    expect(screen.getByText("● running")).toBeInTheDocument();
    expect(screen.getByText("● ask")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /ログイン追加/ }),
    ).toHaveAttribute("aria-current", "true");
  });
  it("opens a session, starts a new one, and toggles a group", async () => {
    const p = sidebarProps({
      onOpen: vi.fn(),
      onNew: vi.fn(),
      onToggleGroup: vi.fn(),
    });
    render(<Sidebar {...p} />);
    await userEvent.click(screen.getByRole("button", { name: /雑談/ }));
    expect(p.onOpen).toHaveBeenCalledWith("s2");
    await userEvent.click(screen.getByRole("button", { name: /new session/ }));
    expect(p.onNew).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /myapp/ }));
    expect(p.onToggleGroup).toHaveBeenCalledWith("w1");
  });
  it("hides sessions of a collapsed group but keeps the heading", () => {
    render(<Sidebar {...sidebarProps({ collapsed: { w1: true } })} />);
    expect(screen.queryByText("ログイン追加")).toBeNull();
    expect(screen.getByText("myapp")).toBeInTheDocument();
  });
  it("reports search text and sort changes", async () => {
    const p = sidebarProps({ onSearch: vi.fn(), onSort: vi.fn() });
    render(<Sidebar {...p} />);
    await userEvent.type(screen.getByLabelText("search sessions"), "a");
    expect(p.onSearch).toHaveBeenCalledWith("a");
    await userEvent.click(screen.getByRole("button", { name: /sort: recent/ }));
    expect(p.onSort).toHaveBeenCalledWith("name");
  });
  it("shows an empty hint", () => {
    render(
      <Sidebar
        {...sidebarProps({
          app: { ...sidebarProps().app, sessions: [], workspaces: [] },
        })}
      />,
    );
    expect(screen.getByText(/セッションはまだありません/)).toBeInTheDocument();
  });
});

describe("WorkspacePicker (folder tab)", () => {
  const workspaces = [
    {
      id: "w1",
      root: "/dev/myapp",
      name: "myapp",
      kind: "git" as const,
      branch: "main",
      lastOpenedAt: 2,
    },
    {
      id: "w2",
      root: "/dev/plain",
      name: "plain",
      kind: "no git" as const,
      lastOpenedAt: 1,
    },
  ];
  const props = () => ({
    workspaces,
    currentId: "w1",
    onPickFolder: vi.fn(async () => "w2" as string | undefined),
    onStart: vi.fn(),
    onForget: vi.fn(),
    onClose: vi.fn(),
  });
  it("lists recent workspaces with kind and branch; repository tab is disabled", () => {
    render(<WorkspacePicker {...props()} />);
    expect(screen.getByText("git · main")).toBeInTheDocument();
    expect(screen.getByText("no git")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "repository" })).toBeDisabled();
    expect(screen.getByLabelText(/worktree/)).toBeDisabled();
  });
  it("starts a session in the selected workspace, optionally read-only", async () => {
    const p = props();
    render(<WorkspacePicker {...p} />);
    await userEvent.click(screen.getByRole("button", { name: /\/dev\/plain/ }));
    await userEvent.click(screen.getByLabelText(/読み取り専用/));
    await userEvent.click(
      screen.getByRole("button", { name: /start session in plain/ }),
    );
    expect(p.onStart).toHaveBeenCalledWith("w2", true);
    expect(p.onClose).toHaveBeenCalled();
  });
  it("selects the folder returned by 'open folder…'", async () => {
    const p = props();
    render(<WorkspacePicker {...p} />);
    await userEvent.click(screen.getByRole("button", { name: /open folder/ }));
    expect(p.onPickFolder).toHaveBeenCalled();
    await userEvent.click(
      await screen.findByRole("button", { name: /start session in plain/ }),
    );
    expect(p.onStart).toHaveBeenCalledWith("w2", false);
  });
  it("can start with no workspace ('その他'); read-only is unavailable then", async () => {
    const p = props();
    render(<WorkspacePicker {...p} />);
    await userEvent.click(
      screen.getByRole("button", { name: /ワークスペースなし/ }),
    );
    expect(screen.getByLabelText(/読み取り専用/)).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: /start session/ }),
    );
    expect(p.onStart).toHaveBeenCalledWith(null, false);
  });
  it("forgets a workspace and closes on Escape", async () => {
    const p = props();
    render(<WorkspacePicker {...p} />);
    await userEvent.click(
      screen.getByRole("button", { name: /plain を一覧から外す/ }),
    );
    expect(p.onForget).toHaveBeenCalledWith("w2");
    await userEvent.keyboard("{Escape}");
    expect(p.onClose).toHaveBeenCalled();
  });
});
