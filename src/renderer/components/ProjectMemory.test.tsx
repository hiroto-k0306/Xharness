import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { type HarnessApi } from "../../shared/ipc.js";
import { type MemoryList } from "../../shared/project-memory.js";
import { ProjectMemoryPanel } from "./ProjectMemory.js";
type UiReply = Awaited<ReturnType<HarnessApi["command"]>>;

function deferred() {
  let resolve!: (reply: UiReply) => void;
  const promise = new Promise<UiReply>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const memory = (topic: string): MemoryList => ({
  scope: "root",
  limit: 100,
  warnings: [],
  entries: [
    {
      id: "one",
      revision: 1,
      scope: "root",
      origin: "manual",
      kind: "decision",
      topic,
      content: "body",
      sources: [],
      status: "candidate",
      confidence: "unverified",
      createdAt: 1,
      updatedAt: 1,
      sourceUnavailable: false,
      expired: false,
      related: [],
    },
  ],
});
it("keeps the newest list when refresh replies arrive out of order", async () => {
  const old = deferred(),
    current = deferred();
  window.harness = {
    command: vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise),
    onEvent: () => () => {},
  };
  render(<ProjectMemoryPanel sessionId="one" />);
  fireEvent.click(screen.getByRole("button", { name: "プロジェクトメモリ" }));
  fireEvent.click(screen.getByRole("button", { name: "再読み込み" }));
  await act(async () =>
    current.resolve({ ok: true, memory: memory("current") }),
  );
  await act(async () => old.resolve({ ok: true, memory: memory("old") }));
  expect(screen.getByText("current")).toBeInTheDocument();
  expect(screen.queryByText("old")).toBeNull();
});
it("fences duplicate submissions and ignores a refresh older than the saved mutation", async () => {
  const old = deferred(),
    saved = deferred();
  const command = vi
    .fn()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(saved.promise);
  window.harness = { command, onEvent: () => () => {} };
  const { container } = render(<ProjectMemoryPanel sessionId="one" />);
  fireEvent.click(screen.getByRole("button", { name: "プロジェクトメモリ" }));
  fireEvent.change(screen.getByRole("textbox", { name: "メモリの話題" }), {
    target: { value: "saved" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "メモリの内容" }), {
    target: { value: "body" },
  });
  fireEvent.submit(container.querySelector("form")!);
  fireEvent.submit(container.querySelector("form")!);
  expect(command).toHaveBeenCalledTimes(2);
  await act(async () => saved.resolve({ ok: true, memory: memory("saved") }));
  await act(async () => old.resolve({ ok: true, memory: memory("old") }));
  expect(screen.getByText("saved")).toBeInTheDocument();
  expect(screen.queryByText("old")).toBeNull();
});
