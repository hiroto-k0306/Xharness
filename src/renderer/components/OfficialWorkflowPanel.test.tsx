import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatOfficialApprovals } from "./ChatOfficialApprovals.js";
import { OfficialWorkflowPanel } from "./OfficialWorkflowPanel.js";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "../../shared/official-workflow.js";
import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
const QUESTION_MODELS = {
  claude: "claude-question-x",
  codex: "codex-question-y",
};
afterEach(() => vi.unstubAllGlobals());
it.each([false, true])(
  "shows Node/Vitest scope and dependency method before bounded approval (Vitest=%s)",
  async (vitest) => {
    const record: WorkflowRecord = {
      version: 1,
      id: "normal-project",
      sessionId: "session",
      simulated: true,
      goal: "fixture",
      cwd: "C:/chosen-project",
      project: {
        source: "C:/chosen-project",
        sourceHead: "a".repeat(40),
        files: ["add.mjs"],
        testFile: "acceptance.test.mjs",
        testProgram: "C:/host/node.exe",
      },
      startedAt: "2026-10-07T00:00:00Z",
      status: "approval",
      next: "approval",
      base: "a".repeat(40),
      head: "a".repeat(40),
      correctionRounds: 0,
      calls: [],
      tools: [],
      checks: [],
      reviews: [],
      commits: [],
      plan: {
        summary: "Bounded task",
        tasks: [
          {
            id: "add",
            title: "Add",
            instructions: "Fix arithmetic",
            files: ["add.mjs"],
            dependsOn: [],
            acceptance: ["project-node-test"],
            assignee: {
              provider: "codex",
              model: "gpt-6-luna",
              effort: "low",
              reason: "bounded",
            },
            reviewer: {
              provider: "claude",
              model: "claude-sonnet-5-5",
              effort: null,
              reason: "other company",
            },
          },
        ],
      },
    };
    if (vitest)
      record.project!.testSetup = {
        kind: "vitest",
        version: "5.0.3",
        config: "vitest.config.ts",
        settings: [{ path: "vitest.config.ts", hash: "a".repeat(64) }],
        dependencies: {
          fingerprint: "b".repeat(64),
          bytes: 1048576,
          files: 10,
          packages: [{ name: "vitest", version: "5.0.3" }],
        },
        command:
          "node node_modules/.xharness-vitest-runner.mjs acceptance.test.ts vitest.config.ts",
      };
    const view: OfficialWorkflowView = {
      available: true,
      simulated: true,
      approval: {
        id: record.id,
        digest: "approved-scope",
        approvalId: "plan-id",
        expiresAt: Date.now() + 60000,
      },
      records: [{ record, resumeBlocked: null, reportHref: "report.html" }],
    };
    const api = vi.fn(async (command?: OfficialWorkflowCommand) => {
      void command;
      return view;
    });
    vi.stubGlobal("harness", { officialWorkflow: api });
    render(<OfficialWorkflowPanel openSignal={1} />);
    const scope = await screen.findByRole("region", {
      name: "実案件の承認範囲",
    });
    expect(scope).toHaveTextContent("C:/chosen-project");
    expect(scope).toHaveTextContent("C:/host/node.exe");
    expect(scope).toHaveTextContent(
      vitest
        ? ".xharness-vitest-runner.mjs acceptance.test.ts vitest.config.ts"
        : "node --test acceptance.test.mjs",
    );
    expect(scope).toHaveTextContent("表示した作業領域で実装");
    expect(scope).toHaveTextContent("OSで完全隔離する機能ではありません");
    if (vitest) {
      expect(scope).toHaveTextContent("元のnode_modulesは共有しません");
      expect(scope).toHaveTextContent("vitest@5.0.3");
    } else expect(scope).not.toHaveTextContent("コピー");
    expect(
      screen.queryByRole("button", { name: "この計画を承認" }),
    ).not.toBeInTheDocument();
    expect(
      api.mock.calls.every(([c]) => c === undefined || c.action !== "approve"),
    ).toBe(true);
  },
);
it.each([
  "saved",
  "saved-default",
  "legacy-claude",
  "legacy-codex",
  "unknown-version",
])(
  "shows saved approval assignments independently of the current selection (%s)",
  async (kind) => {
    const provider = kind === "legacy-claude" ? "claude" : "codex";
    const task = {
      id: "add",
      title: "Add numbers",
      instructions: "Edit add.mjs",
      files: ["add.mjs"],
      dependsOn: [],
      acceptance: ["typed-add"],
      assignee: {
        provider,
        model:
          provider === "claude" ? "claude-haiku-4-5-20251001" : "gpt-6.1-sol",
        effort: "medium",
        reason: "Saved implementation reason",
      },
      ...(kind.startsWith("saved")
        ? {
            reviewer: {
              provider: "claude",
              model: "claude-sonnet-5-5",
              effort: kind === "saved-default" ? null : "low",
              reason: "Saved review reason",
            },
          }
        : {}),
    } as NonNullable<WorkflowRecord["plan"]>["tasks"][number];
    const record: WorkflowRecord = {
      version: 1,
      id: "approval-record",
      simulated: true,
      goal: "fixture",
      cwd: "isolated",
      startedAt: "2026-10-07T00:00:00Z",
      status: "approval",
      next: "approval",
      base: "base",
      head: "base",
      correctionRounds: 0,
      calls: [],
      tools: [],
      checks: [],
      reviews: [],
      commits: [],
      plan: { summary: "Saved plan", tasks: [task] },
    };
    // Future/unknown records can arrive from disk; their missing roles cannot be guessed.
    if (kind === "unknown-version") Object.assign(record, { version: 99 });
    const before = JSON.stringify(record);
    const view: OfficialWorkflowView = {
      available: true,
      simulated: true,
      approval: {
        id: record.id,
        digest: "saved-approval-digest",
        approvalId: "saved-grant",
        expiresAt: Date.now() + 60000,
      },
      records: [{ record, resumeBlocked: null, reportHref: "report.html" }],
    };
    const commands: OfficialWorkflowCommand[] = [];
    vi.stubGlobal("harness", {
      officialWorkflow: vi.fn(async (command: OfficialWorkflowCommand) => {
        commands.push(command);
        return view;
      }),
    });
    const { rerender } = render(
      <OfficialWorkflowPanel mainModel="claude-opus-5-5" mainEffort="max" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "公式workflow" }));
    const implementation = await screen.findByRole("region", {
      name: "add 実装担当",
    });
    const review = screen.getByRole("region", { name: "add レビュー担当" });
    expect(implementation).toHaveTextContent(task.assignee.provider);
    expect(implementation).toHaveTextContent(task.assignee.model);
    expect(implementation).toHaveTextContent("medium");
    if (kind.startsWith("saved")) {
      expect(review).toHaveTextContent("claude-sonnet-5-5");
      expect(review).toHaveTextContent(
        kind === "saved-default" ? "server default（指定なし）" : "low",
      );
      expect(review).toHaveTextContent("Saved review reason");
      expect(review).toHaveTextContent("保存済み計画");
    } else if (kind === "unknown-version") {
      expect(within(review).getAllByText("未確定")).toHaveLength(3);
      expect(review).toHaveTextContent("固定定義なし");
    } else {
      expect(review).toHaveTextContent(
        provider === "claude" ? "gpt-6-luna" : "claude-opus-5-5",
      );
      expect(review).toHaveTextContent(provider === "claude" ? "low" : "high");
      expect(review).toHaveTextContent("計画に記録なし：記録形式v1の固定設定");
    }
    const savedDisplay = review.textContent;
    rerender(
      <OfficialWorkflowPanel
        mainModel="codex:changed-alias"
        mainEffort="high"
      />,
    );
    expect(review.textContent).toBe(savedDisplay);
    expect(JSON.stringify(record)).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "この計画を承認" }));
    await waitFor(() =>
      expect(commands.filter((c) => c.action === "approve")).toEqual([
        {
          action: "approve",
          id: record.id,
          digest: "saved-approval-digest",
          approvalId: "saved-grant",
          allow: true,
        },
      ]),
    );
  },
);
it.each([true, false, "flow"] as const)(
  "shows concrete operation and sends one bound decision (%s)",
  async (allow) => {
    const pending = {
      workflowId: "workflow",
      approvalId: "nonce",
      digest: "a".repeat(64),
      expiresAt: Date.now() + 60000,
      requestId: "request",
      sessionId: "native-session",
      conversationSessionId: "session",
      turnId: "turn",
      itemId: "item",
      command: "Get-Content add.mjs",
      cwd: "isolated workspace",
      targets: ["add.mjs"],
      reason: "Inspect the implementation",
    };
    const view: OfficialWorkflowView = {
      available: true,
      simulated: true,
      activeId: "workflow",
      operationApproval: pending,
      records: [
        {
          record: {
            version: 1,
            id: "workflow",
            sessionId: "session",
            simulated: true,
            goal: "fixture",
            cwd: pending.cwd,
            startedAt: new Date().toISOString(),
            status: "implementing",
            next: "implement",
            base: "a".repeat(64),
            head: "a".repeat(64),
            correctionRounds: 0,
            calls: [],
            tools: [],
            checks: [],
            reviews: [],
            commits: [],
            ...(allow === "flow"
              ? {
                  nativeWork: {
                    validation: "agent-reported" as const,
                    baseline: "files" as const,
                  },
                }
              : {}),
          },
          resumeBlocked: null,
          reportHref: "fixture",
        },
      ],
    };
    let release!: () => void;
    const commands: OfficialWorkflowCommand[] = [];
    const officialWorkflow = vi.fn(async (command: OfficialWorkflowCommand) => {
      commands.push(command);
      if (command.action === "tool_decision")
        await new Promise<void>((r) => {
          release = r;
        });
      return view;
    });
    vi.stubGlobal("harness", { officialWorkflow });
    render(<ChatOfficialApprovals sessionId="session" />);
    await screen.findByRole("alertdialog", { name: "今回の操作の承認" });
    expect(screen.getByText(/操作：/)).toHaveTextContent(pending.command);
    expect(screen.getByText(/作業場所：/)).toHaveTextContent(pending.cwd);
    const button = screen.getByRole("button", {
      name:
        allow === "flow"
          ? "このフローのみ許可"
          : allow
            ? "今回の操作だけ許可"
            : "拒否",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(commands.filter((c) => c.action === "tool_decision")).toEqual([
        {
          action: "tool_decision",
          id: "workflow",
          sessionId: "session",
          approvalId: "nonce",
          digest: pending.digest,
          allow: allow !== false,
          ...(allow === "flow" ? { scope: "flow" } : {}),
        },
      ]),
    );
    release();
    await waitFor(() => expect(button).toBeDisabled());
  },
);
it.each(["claude", "codex"] as const)(
  "displays the same fixed question model the service selects and sends to that company (%s)",
  async (provider) => {
    const view: OfficialWorkflowView = {
      available: true,
      storageReady: true,
      simulated: false,
      questionModels: {
        claude: { id: QUESTION_MODELS.claude },
        codex: { id: QUESTION_MODELS.codex },
      },
      connection: {
        codexPath: "C:/codex.exe",
        workspaceRoot: "",
        status: "configured",
        message: "configured",
      },
      records: [],
    };
    const commands: OfficialWorkflowCommand[] = [];
    vi.stubGlobal("harness", {
      officialWorkflow: vi.fn(async (command: OfficialWorkflowCommand) => {
        commands.push(command);
        return view;
      }),
    });
    render(
      <OfficialWorkflowPanel
        mainModel={provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol"}
        mainEffort="high"
        mainProvider={provider}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "公式workflow" }));
    await waitFor(() =>
      expect(screen.getByLabelText("質問先")).toHaveTextContent(
        QUESTION_MODELS[provider],
      ),
    );
    fireEvent.change(screen.getByLabelText("公式接続への質問"), {
      target: { value: "質問" },
    });
    fireEvent.click(screen.getByRole("button", { name: "質問だけ送信" }));
    await waitFor(() =>
      expect(commands.filter((c) => c.action === "chat")).toEqual([
        { action: "chat", provider, text: "質問" },
      ]),
    );
  },
);
it.each([undefined, "fix-cycle-v1"] as const)(
  "offers the fix-cycle verification task only in its mode (%s)",
  async (verification) => {
    const view: OfficialWorkflowView = {
      available: true,
      simulated: false,
      ...(verification ? { verification } : {}),
      records: [],
    };
    const commands: OfficialWorkflowCommand[] = [];
    const officialWorkflow = vi.fn(async (command: OfficialWorkflowCommand) => {
      commands.push(command);
      return view;
    });
    vi.stubGlobal("harness", { officialWorkflow });
    render(<OfficialWorkflowPanel mainModel="gpt-6-luna" mainEffort="low" />);
    fireEvent.click(screen.getByRole("button", { name: "公式workflow" }));
    await waitFor(() => expect(officialWorkflow).toHaveBeenCalled());
    if (!verification)
      expect(
        screen.queryByRole("button", { name: "合成課題の計画を作成" }),
      ).not.toBeInTheDocument();
    const button = screen.queryByRole("button", {
      name: "修正経路の検証課題を作成",
    });
    if (!verification) {
      expect(button).toBeNull();
      expect(screen.queryByText(/障害注入あり/)).toBeNull();
      return;
    }
    expect(screen.getByText(/検証モード：障害注入あり/)).toBeInTheDocument();
    fireEvent.click(button!);
    await waitFor(() =>
      expect(commands.find((c) => c.action === "create")).toMatchObject({
        action: "create",
        mode: "single",
        task: "typed-add-v1",
        planner: { model: "gpt-6-luna", effort: "low" },
      }),
    );
  },
);
