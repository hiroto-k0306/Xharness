import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  CommandResult,
  HarnessApi,
  HarnessCommand,
} from "../../shared/ipc.js";
import type {
  OfficialSkillEntry,
  OfficialSkillSelection,
} from "../../shared/official-skills.js";
import { OfficialSkillsManager } from "./OfficialSkillsManager.js";

const project: OfficialSkillEntry = {
  provider: "claude",
  scope: "project",
  name: "project-guide",
  description: "Project guide",
  source: ".claude/skills/guide/SKILL.md",
  hash: "a".repeat(64),
  bundleHash: "b".repeat(64),
  eligible: true,
  reasons: [],
};
const user: OfficialSkillEntry = {
  ...project,
  scope: "user",
  name: "user-guide",
  source: "/home/test/.claude/skills/guide/SKILL.md",
};
const unsupported: OfficialSkillEntry = {
  ...project,
  name: "unsupported",
  source: ".claude/skills/unsupported/SKILL.md",
  eligible: false,
  reasons: ["未対応のスキル設定: hooks"],
};
const body = "<script>unsafe markup</script>" + " reference".repeat(600);

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(cleanup);
function setup(
  override?: (command: HarnessCommand) => Promise<CommandResult> | undefined,
) {
  let selected: OfficialSkillSelection[] = [];
  const command = vi.fn(async (c: HarnessCommand): Promise<CommandResult> => {
    const response = override?.(c);
    if (response) return response;
    if (c.type !== "official_skills")
      throw Error("Must not send reference text or invoke legacy skills");
    const request = c.request;
    if (request.action === "list")
      return {
        ok: true,
        officialSkills: {
          selected,
          catalog: {
            entries: [user, project, unsupported].map((entry) => ({
              ...entry,
              provider: request.provider,
            })),
            limits: {},
          },
        },
      };
    if (request.action === "preview") {
      const entry =
        request.source === unsupported.source ? unsupported : project;
      return {
        ok: true,
        officialSkills: {
          selected,
          preview: {
            entry,
            files: [{ relativePath: "SKILL.md", body, hash: entry.hash }],
          },
        },
      };
    }
    if (request.action === "select") selected = [request.selection];
    if (request.action === "clear") selected = [];
    return { ok: true, officialSkills: { selected } };
  });
  window.harness = { command } as unknown as HarnessApi;
  const view = render(
    <OfficialSkillsManager sessionId="s" provider="claude" running={false} />,
  );
  fireEvent.click(screen.getByRole("button", { name: /^公式スキル$/ }));
  return { command, view };
}
async function previewProject() {
  fireEvent.click(
    await screen.findByRole("button", { name: "project-guide · project" }),
  );
  await screen.findByText(body);
}
it("lists user and project skills, previews complete text and saves exact pins without sending reference text", async () => {
  const { command } = setup();
  await screen.findByRole("button", { name: "user-guide · user" });
  await previewProject();
  expect(body.length).toBeGreaterThan(4000);
  expect(document.querySelector("script")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "この公式スキルを選択" }));
  const chosen = screen.getByRole("region", { name: "選択済みの公式スキル" });
  await waitFor(() => expect(chosen).toHaveTextContent(project.source));
  expect(chosen).toHaveTextContent(project.bundleHash);
  expect(
    command.mock.calls.find(
      ([c]) => c.type === "official_skills" && c.request.action === "select",
    )?.[0],
  ).toEqual({
    type: "official_skills",
    sessionId: "s",
    request: {
      action: "select",
      selection: {
        provider: project.provider,
        scope: project.scope,
        name: project.name,
        source: project.source,
        hash: project.hash,
        bundleHash: project.bundleHash,
      },
    },
  });
  expect(command.mock.calls.every(([c]) => c.type === "official_skills")).toBe(
    true,
  );
  expect(chosen).toHaveTextContent("実際に使用・完了した証明ではありません");
  fireEvent.click(
    within(chosen).getByRole("button", { name: "選択をすべて解除" }),
  );
  await waitFor(() => expect(chosen).toHaveTextContent("選択なし"));
});
it("shows unsupported metadata and keeps it unselectable separately from vendor authorship", async () => {
  setup();
  fireEvent.click(
    await screen.findByRole("button", { name: "unsupported · project" }),
  );
  await screen.findByText(body);
  expect(
    screen.getByRole("button", { name: "この公式スキルを選択" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("region", { name: "公式スキル本文プレビュー" }),
  ).toHaveTextContent("hooks");
  expect(
    screen.getByText(/提供元の公式作成・監修や安全性の認定/),
  ).toBeInTheDocument();
});
it("shows Codex execution unsupported without a plain-reference fallback", async () => {
  const { command } = setup();
  await screen.findByRole("button", { name: "user-guide · user" });
  fireEvent.change(
    screen.getByRole("combobox", { name: "公式スキルの実行基盤" }),
    { target: { value: "codex" } },
  );
  await waitFor(() =>
    expect(
      command.mock.calls.some(
        ([c]) =>
          c.type === "official_skills" &&
          c.request.action === "list" &&
          c.request.provider === "codex",
      ),
    ).toBe(true),
  );
  expect(
    screen.getByText(/未選択スキルの隔離を確認できないため/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/参考資料へ自動で置き換えません/),
  ).toBeInTheDocument();
});
it("does not report selected when main rejects a changed source", async () => {
  setup((c) =>
    c.type === "official_skills" && c.request.action === "select"
      ? Promise.resolve({ ok: false, error: "スキルが変更されました" })
      : undefined,
  );
  await previewProject();
  fireEvent.click(screen.getByRole("button", { name: "この公式スキルを選択" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("変更されました");
  expect(
    screen.getByRole("region", { name: "選択済みの公式スキル" }),
  ).toHaveTextContent("選択なし");
});
it("discards delayed preview after switching sessions", async () => {
  let resolve!: (result: CommandResult) => void;
  const delayed = new Promise<CommandResult>((done) => {
    resolve = done;
  });
  const { view } = setup((c) =>
    c.type === "official_skills" &&
    c.sessionId === "s" &&
    c.request.action === "preview"
      ? delayed
      : undefined,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "project-guide · project" }),
  );
  view.rerender(
    <OfficialSkillsManager sessionId="new" provider="claude" running={false} />,
  );
  await screen.findByRole("button", { name: "project-guide · project" });
  resolve({
    ok: true,
    officialSkills: {
      selected: [],
      preview: {
        entry: project,
        files: [
          {
            relativePath: "SKILL.md",
            body: "stale session body",
            hash: project.hash,
          },
        ],
      },
    },
  });
  await waitFor(() =>
    expect(screen.queryByText("stale session body")).toBeNull(),
  );
});
it("disables selection and clear while a workflow is running", async () => {
  const { view, command } = setup();
  await previewProject();
  fireEvent.click(screen.getByRole("button", { name: "この公式スキルを選択" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "選択をすべて解除" }),
    ).toBeEnabled(),
  );
  view.rerender(
    <OfficialSkillsManager sessionId="s" provider="claude" running />,
  );
  const count = command.mock.calls.length;
  expect(
    screen.getByRole("button", { name: "この公式スキルを選択" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "選択をすべて解除" }));
  expect(command.mock.calls.length).toBe(count);
});
