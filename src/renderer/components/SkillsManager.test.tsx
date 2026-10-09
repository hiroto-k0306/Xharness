import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type HarnessCommand,
  type CommandResult,
  type HarnessApi,
} from "../../shared/ipc.js";
import {
  type SkillEntry,
  type SkillPreview,
  skillReferenceSubmission,
} from "../../shared/project-skills.js";
import { SkillsManager } from "./SkillsManager.js";

const entry: SkillEntry = {
  name: "Example",
  description: "Project guidance",
  source: ".agents/skills/example/SKILL.md",
  hash: "a".repeat(64),
  fileBytes: 90,
  frontmatterBytes: 20,
  ignoredFrontmatter: false,
  redacted: false,
};
const preview: SkillPreview = {
  formatVersion: 1,
  operation: "load",
  untrusted: true,
  notice: "Reference only",
  entry,
  body: "Treat this project carefully.",
  truncated: false,
  budget: { readBytes: 90, returnedCharacters: 28 },
  limits: { bodyCharacters: 12000 },
};
afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});

async function setup(
  officialDefault = true,
  value = preview,
  recheck?: CommandResult,
) {
  let reads = 0;
  const command = vi.fn(async (c: HarnessCommand): Promise<CommandResult> => {
    if (c.type === "project_skills" && c.request.action === "list")
      return {
        ok: true,
        skills: {
          formatVersion: 1,
          operation: "list",
          untrusted: true,
          notice: "",
          entries: [entry],
          skipped: {},
          truncated: false,
          budget: { directoryEntries: 1, readBytesUpperBound: 90 },
          limits: { listReadBytes: 1000 },
        },
      };
    if (c.type === "project_skills" && c.request.action === "preview") {
      reads++;
      return reads > 1 && recheck ? recheck : { ok: true, skills: value };
    }
    return { ok: true };
  });
  window.harness = { command, onEvent: () => () => {} } as HarnessApi;
  render(
    <SkillsManager
      sessionId="session"
      open
      onOpenChange={() => {}}
      running={false}
      receipts={[]}
      officialDefault={officialDefault}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "一覧を取得・更新" }));
  await waitFor(() =>
    expect(
      within(screen.getByRole("list", { name: "スキル一覧" })).getByRole(
        "button",
      ),
    ).toBeDefined(),
  );
  fireEvent.click(
    within(screen.getByRole("list", { name: "スキル一覧" })).getByRole(
      "button",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "この版をプレビュー" }));
  await screen.findByLabelText("スキル本文プレビュー");
  return command;
}

it("rechecks the selected hash through approved preview before sending a bounded reference", async () => {
  const command = await setup();
  fireEvent.click(
    screen.getByRole("button", { name: "この版を参考資料として送る" }),
  );
  await screen.findByText(/参考資料送信済:/);
  const calls = command.mock.calls.map(([c]) => c);
  expect(
    calls.filter(
      (c) => c.type === "project_skills" && c.request.action === "preview",
    ),
  ).toHaveLength(2);
  const sent = calls.find((c) => c.type === "send");
  expect(sent?.type).toBe("send");
  if (sent?.type !== "send") throw new Error("Missing reference send");
  expect(sent.text).toContain(preview.body);
  expect(sent.text).toContain(entry.hash);
  expect(sent.text).not.toContain("LoadProjectSkill");
  expect(sent.text.length).toBeLessThanOrEqual(4000);
  expect(screen.queryByText("会話に読込済み（この版）")).toBeNull();
});

it("does not send if the selected version changed at the second preview", async () => {
  const command = await setup(true, preview, {
    ok: true,
    skills: { ...preview, entry: { ...entry, hash: "b".repeat(64) } },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "この版を参考資料として送る" }),
  );
  await screen.findByText(/再確認に失敗/);
  expect(command.mock.calls.some(([c]) => c.type === "send")).toBe(false);
});

it("does not send after a denied fresh preview", async () => {
  const command = await setup(true, preview, {
    ok: false,
    error: "スキル読取が拒否されました。",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "この版を参考資料として送る" }),
  );
  await screen.findByText("スキル読取が拒否されました。");
  expect(command.mock.calls.some(([c]) => c.type === "send")).toBe(false);
});

it("disables truncated and oversized submissions without dropping reference text", async () => {
  const command = await setup(true, { ...preview, body: "x".repeat(4000) });
  expect(
    screen.getByRole("button", { name: "この版を参考資料として送る" }),
  ).toBeDisabled();
  expect(screen.getByText(/4000文字上限/)).toBeDefined();
  expect(command.mock.calls.some(([c]) => c.type === "send")).toBe(false);
  expect(
    skillReferenceSubmission({ ...preview, truncated: true }),
  ).toHaveProperty("error");
});

it("preserves the legacy tool load request", async () => {
  const command = await setup(false);
  fireEvent.click(
    screen.getByRole("button", { name: "会話でこの版を読み込む" }),
  );
  await waitFor(() =>
    expect(command.mock.calls.some(([c]) => c.type === "send")).toBe(true),
  );
  const sent = command.mock.calls
    .map(([c]) => c)
    .find((c) => c.type === "send");
  expect(sent?.type === "send" && sent.text).toContain("LoadProjectSkill");
});

it("rejects attached reference submissions explicitly", () => {
  expect(
    skillReferenceSubmission({
      ...preview,
      reference: {
        source: ".agents/skills/example/guide.md",
        hash: "b".repeat(64),
        fileBytes: 12,
        redacted: false,
      },
    }),
  ).toHaveProperty("error");
});
