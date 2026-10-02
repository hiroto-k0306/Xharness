import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { applyEvent, type EventState } from "../state/store.js";
import { McpStatus } from "./McpStatus.js";
import { matchSuggestions, PromptLine } from "./PromptLine.js";
import { Transcript } from "./Transcript.js";

const servers = [
  {
    name: "github",
    type: "http" as const,
    status: "connected" as const,
    tools: 3,
    resources: 1,
    prompts: 2,
    oauth: true,
  },
  {
    name: "db",
    type: "stdio" as const,
    status: "failed" as const,
    tools: 0,
    error: "spawn npx ENOENT",
  },
  {
    name: "new",
    type: "stdio" as const,
    status: "unapproved" as const,
    tools: 0,
  },
];

describe("/mcp status (§25.8)", () => {
  it("shows each server and sends the matching command from its buttons", async () => {
    const onCommand = vi.fn();
    render(<McpStatus servers={servers} busy={false} onCommand={onCommand} />);
    const github = within(
      screen
        .getByTestId("mcp-status")
        .querySelector('[data-server="github"]')! as HTMLElement,
    );
    expect(github.getByText("接続中")).toBeInTheDocument();
    expect(
      github.getByText(/ツール 3 · リソース 1 · プロンプト 2/),
    ).toBeInTheDocument();
    await userEvent.click(github.getByRole("button", { name: "再接続" }));
    await userEvent.click(
      github.getByRole("button", { name: "承認を取り消す" }),
    );
    await userEvent.click(github.getByRole("button", { name: "ログアウト" }));
    expect(onCommand.mock.calls.map((c) => c[0])).toEqual([
      "/mcp reconnect github",
      "/mcp reset github",
      "/mcp logout github",
    ]);
    const db = within(
      screen
        .getByTestId("mcp-status")
        .querySelector('[data-server="db"]')! as HTMLElement,
    );
    expect(db.getByText("spawn npx ENOENT")).toBeInTheDocument();
    expect(db.queryByRole("button", { name: "ログアウト" })).toBeNull();
    const fresh = within(
      screen
        .getByTestId("mcp-status")
        .querySelector('[data-server="new"]')! as HTMLElement,
    );
    expect(fresh.getByRole("button", { name: "接続" })).toBeInTheDocument();
    expect(fresh.queryByRole("button", { name: "承認を取り消す" })).toBeNull();
  });
  it("disables the buttons while a turn is running", () => {
    render(<McpStatus servers={servers} busy onCommand={() => {}} />);
    for (const b of screen.getAllByRole("button")) expect(b).toBeDisabled();
  });
  it("the store keeps the state for completion and adds a status block only for /mcp", () => {
    let s: EventState = { app: null, views: {} };
    const event = {
      type: "mcp" as const,
      sessionId: "s1",
      servers,
      prompts: [
        {
          command: "/mcp__github__review",
          arguments: [{ name: "pr", required: true }],
        },
      ],
      show: false,
    };
    s = applyEvent(s, event);
    expect(s.views.s1!.items).toEqual([]);
    expect(s.views.s1!.mcp!.prompts[0]!.command).toBe("/mcp__github__review");
    s = applyEvent(s, { ...event, show: true });
    expect(s.views.s1!.items).toHaveLength(1);
    render(<Transcript items={s.views.s1!.items} running={false} model="m" />);
    expect(screen.getByTestId("mcp-status")).toBeInTheDocument();
  });
});

describe("prompt completion (§25.6)", () => {
  const suggestions = [
    { value: "/mcp", description: "MCP" },
    { value: "/mcp__github__review", args: "<pr>", description: "Review a PR" },
    { value: "/mcp__db__schema", args: "" },
  ];
  it("matches the command prefix and closes after a space", () => {
    expect(
      matchSuggestions("/mcp__g", suggestions).map((s) => s.value),
    ).toEqual(["/mcp__github__review"]);
    expect(matchSuggestions("/mcp", suggestions)).toHaveLength(2);
    expect(matchSuggestions("/mcp__github__review x", suggestions)).toEqual([]);
    expect(matchSuggestions("hello", suggestions)).toEqual([]);
  });
  it("Tab inserts the selected command and arrows move the selection", async () => {
    const onSubmit = vi.fn();
    render(
      <PromptLine
        cwdLabel="ws"
        running={false}
        blocked={false}
        modelLabel="m"
        modelColor="red"
        onSubmit={onSubmit}
        suggestions={suggestions}
      />,
    );
    const input = screen.getByLabelText("prompt");
    await userEvent.type(input, "/mcp_");
    const list = screen.getByRole("listbox", { name: "commands" });
    expect(within(list).getAllByRole("option")).toHaveLength(2);
    expect(within(list).getByText("<pr>")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}{Tab}");
    expect(input).toHaveValue("/mcp__db__schema");
    await userEvent.clear(input);
    await userEvent.type(input, "/mcp__gi");
    await userEvent.keyboard("{Tab}");
    // 引数のあるプロンプトは、続けて引数を打てるよう空白を足す
    expect(input).toHaveValue("/mcp__github__review ");
    expect(screen.queryByRole("listbox")).toBeNull();
    await userEvent.type(input, "42{Enter}");
    expect(onSubmit).toHaveBeenCalledWith("/mcp__github__review 42");
  });
});
