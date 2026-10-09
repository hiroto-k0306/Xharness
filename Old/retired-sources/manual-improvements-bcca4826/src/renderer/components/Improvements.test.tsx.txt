import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import type { HarnessApi } from "../../shared/ipc.js";
import type { ImprovementView } from "../../shared/improvements.js";
import { ImprovementsPanel } from "./Improvements.js";

it("closes evaluation before a delayed session creation reply, without sending twice", async () => {
  const view: ImprovementView = {
    limit: 20,
    rows: [],
    entries: [
      {
        id: "comparison",
        name: "synthetic",
        scope: "root",
        revision: 1,
        source: {},
        cases: [
          {
            id: "case",
            prompt: "synthetic",
            criteria: "pong",
            taskType: "test",
            difficulty: "small",
            environment: "fake",
          },
        ],
        versions: [
          {
            id: "baseline",
            name: "baseline",
            body: "test",
            hash: "hash",
            createdAt: 1,
          },
        ],
        results: [],
        history: [],
      },
    ],
  };
  let release!: (r: Awaited<ReturnType<HarnessApi["command"]>>) => void;
  const created = new Promise<Awaited<ReturnType<HarnessApi["command"]>>>(
    (r) => {
      release = r;
    },
  );
  const command = vi.fn<HarnessApi["command"]>(async (c) => {
    if (c.type === "new_session") return created;
    if (c.type === "improvements")
      return {
        ok: true,
        improvements: view,
        preparedPrompt:
          c.request.action === "prepare" ? "synthetic" : undefined,
      };
    return { ok: true };
  });
  window.harness = { command, onEvent: () => () => {} };
  function Panel() {
    const [open, setOpen] = useState(false);
    return (
      <ImprovementsPanel
        sessionId="old-session"
        workspaceId="workspace"
        open={open}
        onOpenChange={setOpen}
      />
    );
  }
  render(<Panel />);
  fireEvent.click(screen.getByRole("button", { name: "改善版の比較" }));
  await screen.findByRole("option", { name: "synthetic" });
  fireEvent.change(screen.getByLabelText("比較を選択"), {
    target: { value: "comparison" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "評価依頼を準備（通信なし）" }),
  );
  await screen.findByLabelText("固定評価依頼");
  await waitFor(() =>
    expect(screen.getByLabelText("操作を明示確認")).toBeEnabled(),
  );
  fireEvent.click(screen.getByLabelText("操作を明示確認"));
  fireEvent.click(screen.getByRole("button", { name: "新規会話で評価実行" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
  );
  expect(
    command.mock.calls.filter(([c]) => c.type === "new_session"),
  ).toHaveLength(1);
  expect(command.mock.calls.filter(([c]) => c.type === "send")).toHaveLength(0);
  await act(async () => {
    release({ ok: true, sessionId: "new-session" });
    await created;
  });
  await waitFor(() =>
    expect(command.mock.calls.filter(([c]) => c.type === "send")).toHaveLength(
      1,
    ),
  );
  expect(
    command.mock.calls.find(([c]) => c.type === "send")?.[0],
  ).toMatchObject({ sessionId: "new-session", text: "synthetic" });
});
