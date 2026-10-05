import { STEP_NODES } from "../shared/ipc.js";
import { DEFAULT_IMAGES } from "../shared/images.js";
import { builtinCommands } from "../shared/commands.js";
import { AgentsPanel } from "./components/AgentsPanel.js";
import { AuthenticationPanel } from "./components/AuthenticationPanel.js";
import { PhaseBar } from "./components/PhaseBar.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { PlanApproval } from "./components/PlanApproval.js";
import { RewindApproval } from "./components/RewindApproval.js";
import { useEffect, useState } from "react";
import {
  Hero,
  LoopFlow,
  Receipts,
  UsagePopover,
} from "./components/Activity.js";
import { PermissionInline } from "./components/PermissionInline.js";
import { PromptLine } from "./components/PromptLine.js";
import { QuotaPause } from "./components/QuotaPause.js";
import { ProjectMemoryPanel } from "./components/ProjectMemory.js";
import { SkillsManager } from "./components/SkillsManager.js";
import { Sidebar } from "./components/Sidebar.js";
import { StepTabs } from "./components/StepTabs.js";
import { TitleBar } from "./components/TitleBar.js";
import { Transcript } from "./components/Transcript.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { providerOf } from "./state/steps.js";
import { useStore } from "./state/store.js";
import styles from "./App.module.css";

/** effort は Haiku には送らないので表示もしない(§7.1) */
function modelLabel(model: string, effort: string): string {
  return model === "fake" || /^claude-haiku/.test(model)
    ? model
    : `${model} · ${effort}`;
}

export function App() {
  const [modelOpen, setModelOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [selectedAgents, setSelectedAgents] = useState<Record<string, string>>(
    {},
  );
  const [pane, setPane] = useState("transcript");
  const [usageOpen, setUsageOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const s = useStore();
  const { app, views, prefs } = s;
  useEffect(() => s.start(), []);

  const current = app?.currentSessionId ?? null;
  useEffect(() => setSkillsOpen(false), [current]);
  const view = current ? views[current] : undefined;
  const session = app?.sessions.find((x) => x.id === current);
  const workspace = app?.workspaces.find((w) => w.id === session?.workspaceId);
  const waiting = !!view?.pending;
  const selected = current ? (selectedAgents[current] ?? "auto") : "auto";
  const agentId =
    selected === "auto" ? (view?.activeAgent ?? "main") : selected;
  const agent = view?.agents?.[agentId];
  const agentStep = view?.agentSteps?.[agentId];
  const activeView = agent
    ? {
        ...view!,
        running: agent.status === "running",
        step: agentStep
          ? {
              step: (STEP_NODES.indexOf(agentStep.step) + 1) as
                1 | 2 | 3 | 4 | 5 | 6,
              node: agentStep.step,
              round: agentStep.round,
            }
          : undefined,
      }
    : view;
  const agentItems = agent
    ? (agent.items ??
      (agent.text
        ? [{ kind: "assistant" as const, id: agentId, text: agent.text }]
        : []))
    : undefined;
  const transcriptItems =
    selected === "auto" || !agent
      ? (view?.items ?? [])
      : agentItems && agentItems.length > 0
        ? agentItems
        : [
            {
              kind: "notice" as const,
              id: `empty-${agentId}`,
              tone: "dim" as const,
              text: `${agent.name} の出力はまだありません`,
            },
          ];
  const transcriptKey = `${current}:${selected === "auto" ? "main" : agentId}`;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "m") {
        e.preventDefault();
        setModelOpen((v) => !v);
        return;
      }
      if (mod && key === "u") {
        e.preventDefault();
        setUsageOpen((v) => !v);
        return;
      }
      if (mod && key === "h") {
        e.preventDefault();
        s.setPrefs({ heroOpen: !prefs.heroOpen });
        return;
      }
      if (e.shiftKey && e.key === "Tab" && current) {
        e.preventDefault();
        const modes = ["default", "acceptEdits", "plan"] as const;
        const index = modes.indexOf(session?.permissionMode ?? "default");
        void window.harness.command({
          type: "set_mode",
          sessionId: current,
          mode: modes[(index + 1) % 3]!,
        });
        return;
      }
      if (mod && key === "n") {
        e.preventDefault();
        void s.newSession(session?.workspaceId ?? null, session?.readOnly);
      } else if (mod && key === "w" && current) {
        e.preventDefault();
        s.closeSession(current);
      } else if (mod && key === "b") {
        e.preventDefault();
        s.setPrefs({ sidebarOpen: !prefs.sidebarOpen });
      } else if (mod && key === "o") {
        e.preventDefault();
        s.setPrefs({ pickerOpen: !prefs.pickerOpen });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!app) return <div className={styles.boot}># starting…</div>;
  const model = session?.model ?? app.model;
  const effort = session?.effort ?? app.effort;
  const agentsPanel = (
    <AgentsPanel
      view={view}
      selected={selected}
      model={model}
      onSelect={(id) => {
        if (current) setSelectedAgents((v) => ({ ...v, [current]: id }));
      }}
    />
  );
  return (
    <div className={styles.win}>
      <TitleBar
        usage={
          <UsagePopover
            usage={s.usage}
            calls={session?.llmCalls}
            fallback={app.fallback}
            open={usageOpen}
            onToggle={() => setUsageOpen((v) => !v)}
            onClose={() => setUsageOpen(false)}
          />
        }
        workspaceName={workspace?.name}
        branch={session?.branch ?? workspace?.branch}
        pickerOpen={prefs.pickerOpen}
        onTogglePicker={() => s.setPrefs({ pickerOpen: !prefs.pickerOpen })}
        fake={app.fake}
      />
      {prefs.pickerOpen && (
        <WorkspacePicker
          fake={app.fake}
          gitAvailable={app.gitAvailable}
          progress={s.repositoryProgress}
          workspaces={app.workspaces}
          currentId={session?.workspaceId ?? null}
          onPickFolder={s.pickFolder}
          onStart={(id, readOnly, isolated, base, branch) =>
            void s.newSession(id, readOnly, isolated, base, branch)
          }
          onForget={(id) =>
            void window.harness.command({
              type: "forget_workspace",
              workspaceId: id,
            })
          }
          onClose={() => s.setPrefs({ pickerOpen: false })}
        />
      )}
      <div className={styles.body} data-sidebar={prefs.sidebarOpen}>
        {deleteId && (
          <div className={styles.deleteOverlay}>
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-session-title"
              className={styles.deleteDialog}
            >
              <h2 id="delete-session-title">セッションを削除しますか？</h2>
              <p>{app.sessions.find((x) => x.id === deleteId)?.title}</p>
              <p>
                会話履歴と巻き戻し用の記録を削除します。この操作は取り消せません。
              </p>
              {deleteError && (
                <p role="alert">
                  削除できませんでした。実行中の処理を停止してから再試行してください。
                </p>
              )}
              {app.sessions.find((x) => x.id === deleteId)?.worktree && (
                <p>
                  worktreeと作業ファイルは残ります。片付ける場合はキャンセルし、対象セッションのworktree操作を先に行ってください。
                </p>
              )}
              <button
                type="button"
                disabled={deleting}
                autoFocus
                onClick={() => {
                  setDeleteId(null);
                  setDeleteError(false);
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    if (await s.deleteSession(deleteId)) {
                      setDeleteId(null);
                      setDeleteError(false);
                    } else setDeleteError(true);
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? "削除中…" : "削除する"}
              </button>
            </div>
          </div>
        )}
        {prefs.sidebarOpen && (
          <Sidebar
            width={prefs.sidebarWidth}
            onResize={
              app.phase4
                ? (sidebarWidth) => s.setPrefs({ sidebarWidth })
                : undefined
            }
            app={app}
            views={views}
            collapsed={prefs.collapsed}
            sort={prefs.sort}
            search={prefs.search}
            onNew={() =>
              void s.newSession(session?.workspaceId ?? null, session?.readOnly)
            }
            onOpen={s.openSession}
            onDelete={setDeleteId}
            onToggleGroup={s.toggleGroup}
            onSearch={(search) => s.setPrefs({ search })}
            onSort={(sort) => s.setPrefs({ sort })}
          />
        )}
        <main className={styles.content}>
          {!app.fake && app.authentication && (
            <AuthenticationPanel
              views={app.authentication}
              disabled={app.sessions.some(
                (session) => session.status !== "idle",
              )}
              command={(type, provider) =>
                window.harness.command(
                  type === "authenticate" && provider
                    ? { type, provider }
                    : { type: "refresh_auth" },
                )
              }
            />
          )}
          {session?.worktree && (
            <div>
              <span>worktree · {session.worktree.branch} </span>
              <button
                onClick={async () => {
                  if (
                    !window.confirm(
                      "消えた worktree を保存済みブランチから復元しますか？",
                    )
                  )
                    return;
                  const result = await window.harness.command({
                    type: "restore_worktree",
                    sessionId: session.id,
                    confirmed: true,
                  });
                  if (!result.ok)
                    s.apply({
                      type: "error",
                      sessionId: session.id,
                      message: result.error,
                    });
                }}
              >
                復元
              </button>
              <select
                aria-label="worktree action"
                defaultValue="keep"
                onChange={async (e) => {
                  const action = e.target.value as
                    "keep" | "merge" | "remove" | "remove_branch";
                  if (
                    action !== "keep" &&
                    !window.confirm(
                      action === "merge"
                        ? "元のリポジトリへマージしますか？"
                        : "worktree を削除しますか？未コミットの変更も失われます。",
                    )
                  ) {
                    e.target.value = "keep";
                    return;
                  }
                  const result = await window.harness.command({
                    type: "finish_worktree",
                    sessionId: session.id,
                    action,
                    confirmed: true,
                  });
                  if (!result.ok)
                    s.apply({
                      type: "error",
                      sessionId: session.id,
                      message: result.error,
                    });
                  e.target.value = "keep";
                }}
              >
                <option value="keep">残す</option>
                <option value="merge">元のブランチへマージ</option>
                <option value="remove">ブランチを残して削除</option>
                <option value="remove_branch">worktree とブランチを削除</option>
              </select>
            </div>
          )}
          {app.phase4 && (
            <Hero
              model={model}
              view={view}
              open={prefs.heroOpen}
              onToggle={() => s.setPrefs({ heroOpen: !prefs.heroOpen })}
              extra={agentsPanel}
            />
          )}
          <PhaseBar
            view={view}
            model={model}
            onPhase={(phase) => void s.send(`/phase ${phase}`)}
            onJump={(phase) => {
              setPane("transcript");
              if (current)
                setSelectedAgents((v) => ({ ...v, [current]: "main" }));
              requestAnimationFrame(() =>
                document
                  .querySelectorAll('[data-phase="' + phase + '"]')
                  .item(0)
                  ?.scrollIntoView?.({ block: "start" }),
              );
            }}
          />
          {!app.phase4 && agentsPanel}
          <StepTabs
            active={activeView?.step}
            waiting={waiting}
            model={agent?.model ?? model}
          />
          {app.phase4 && (
            <div
              className={styles.paneTabs}
              role="tablist"
              aria-label="session panels"
            >
              <button
                role="tab"
                aria-selected={pane === "transcript"}
                onClick={() => setPane("transcript")}
              >
                Transcript
              </button>
              <button
                role="tab"
                aria-selected={pane === "flow"}
                onClick={() => setPane("flow")}
              >
                LoopFlow
              </button>
            </div>
          )}
          <div className={styles.agentArea}>
            <div className={styles.middle} data-pane={pane}>
              <Transcript
                key={transcriptKey}
                items={transcriptItems}
                running={!!view?.running}
                model={model}
                onCommand={(text) => void s.send(text)}
                blocked={
                  waiting || !!view?.rewind || session?.status !== "idle"
                }
                onReply={selected === "auto" || !agent ? s.send : undefined}
              />
              {app.phase4 && (
                <LoopFlow view={activeView} model={agent?.model ?? model} />
              )}
            </div>
          </div>
          {app.phase4 && (
            <Receipts
              receipts={view?.receipts}
              sessionId={current ?? undefined}
              running={session?.status !== "idle"}
            />
          )}
          {view?.pending?.plan && current ? (
            <PlanApproval
              key={view.pending.requestId}
              plan={view.pending.plan}
              models={app.models ?? []}
              onApprove={async (items) => {
                const result = await window.harness.command({
                  type: "plan_response",
                  sessionId: current,
                  requestId: view.pending!.requestId,
                  items,
                });
                if (!result.ok)
                  s.apply({
                    type: "error",
                    sessionId: current,
                    message: result.error,
                  });
              }}
              onDeny={() => s.respond("deny")}
              onRevise={() => {
                s.respond("deny");
                s.apply({
                  type: "notice",
                  sessionId: current,
                  tone: "dim",
                  message: "計画への修正指示を入力してください",
                });
              }}
            />
          ) : (
            view?.pending &&
            !skillsOpen && (
              <PermissionInline
                oneTime={view.pending.oneTime}
                persistent={app.phase4}
                tool={view.pending.tool}
                summary={view.pending.summary}
                onRespond={s.respond}
              />
            )
          )}
          {view?.rewind && current && (
            <RewindApproval
              key={view.rewind.requestId}
              preview={view.rewind.preview}
              onRespond={(choice) => {
                void window.harness.command({
                  type: "rewind_response",
                  sessionId: current,
                  requestId: view.rewind!.requestId,
                  choice,
                });
              }}
            />
          )}
          {modelOpen && current && (
            <ModelPicker
              models={app.models ?? []}
              model={model}
              effort={effort}
              onDefault={async (model, effort) => {
                const result = await window.harness.command({
                  type: "set_default_model",
                  model,
                  effort,
                });
                if (result.ok) setModelOpen(false);
                else
                  s.apply({
                    type: "error",
                    sessionId: current,
                    message: result.error,
                  });
              }}
              onClose={() => setModelOpen(false)}
              onApply={async (model, effort) => {
                const result = await window.harness.command({
                  type: "set_model",
                  sessionId: current,
                  model,
                  effort,
                });
                if (result.ok) setModelOpen(false);
                else
                  s.apply({
                    type: "error",
                    sessionId: current,
                    message: result.error,
                  });
              }}
            />
          )}
          {(session?.imageBytes ?? 0) >
            (app.images?.warnSessionBytes ??
              DEFAULT_IMAGES.warnSessionBytes) && (
            <div role="status">
              セッションの画像合計が警告値を超えています。再送する履歴を減らすには
              /compact を実行してください（保存済み画像は残ります）。
            </div>
          )}
          {session?.quotaPause && current && (
            <QuotaPause pause={session.quotaPause} sessionId={current} />
          )}
          {current && session?.workspaceId && (
            <SkillsManager
              key={`skills-${current}`}
              sessionId={current}
              open={skillsOpen}
              onOpenChange={setSkillsOpen}
              running={!!view?.running || waiting}
              persistent={app.phase4}
              receipts={view?.receipts ?? []}
              permission={view?.pending}
            />
          )}
          {current && session?.workspaceId && (
            <ProjectMemoryPanel key={current} sessionId={current} />
          )}
          <PromptLine
            maxImages={app.images?.maxPerMessage}
            sessionId={current}
            imageInput={app.models?.find((m) => m.id === model)?.imageInput}
            onStop={s.abort}
            onModel={() => setModelOpen((v) => !v)}
            mode={
              app.phase4 ? (session?.permissionMode ?? "default") : undefined
            }
            readOnly={session?.readOnly}
            onMode={(mode) => {
              if (current)
                void window.harness.command({
                  type: "set_mode",
                  sessionId: current,
                  mode,
                });
            }}
            suggestions={[
              ...builtinCommands.filter((c) => c.value !== "/exit"),
              ...(app.commands ?? []),
              ...(view?.mcp?.prompts ?? []).map((p) => ({
                value: p.command,
                args: p.arguments
                  .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
                  .join(" "),
                description: p.description,
              })),
            ]}
            cwdLabel={workspace?.name ?? (session ? "scratch" : "~")}
            running={!!view?.running}
            blocked={waiting}
            modelLabel={modelLabel(model, effort)}
            modelColor={
              providerOf(model) === "codex" ? "var(--codex)" : "var(--claude)"
            }
            onSubmit={(text, images) => s.send(text, images)}
          />
        </main>
      </div>
    </div>
  );
}
