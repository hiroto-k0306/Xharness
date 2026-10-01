import { useEffect, useState } from "react";
import {
  Hero,
  LoopFlow,
  Receipts,
  UsagePopover,
} from "./components/Activity.js";
import { PermissionInline } from "./components/PermissionInline.js";
import { PromptLine } from "./components/PromptLine.js";
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
  const [pane, setPane] = useState("transcript");
  const [usageOpen, setUsageOpen] = useState(false);
  const s = useStore();
  const { app, views, prefs } = s;
  useEffect(() => s.start(), []);

  const current = app?.currentSessionId ?? null;
  const view = current ? views[current] : undefined;
  const session = app?.sessions.find((x) => x.id === current);
  const workspace = app?.workspaces.find((w) => w.id === session?.workspaceId);
  const waiting = !!view?.pending;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
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
      } else if (e.key === "Escape" && view?.running && !view.pending)
        s.abort(); // 実行中の中断(権限待ちの Esc は PermissionInline が deny にする)
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!app) return <div className={styles.boot}># starting…</div>;
  const model = session?.model ?? app.model;
  const effort = session?.effort ?? app.effort;
  return (
    <div className={styles.win}>
      <TitleBar
        usage={
          <UsagePopover
            usage={s.usage}
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
            onToggleGroup={s.toggleGroup}
            onSearch={(search) => s.setPrefs({ search })}
            onSort={(sort) => s.setPrefs({ sort })}
          />
        )}
        <main className={styles.content}>
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
            />
          )}
          <StepTabs active={view?.step} waiting={waiting} model={model} />
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
          <div className={styles.middle} data-pane={pane}>
            <Transcript
              items={view?.items ?? []}
              running={!!view?.running}
              model={model}
            />
            {app.phase4 && <LoopFlow view={view} model={model} />}
          </div>
          {app.phase4 && <Receipts receipts={view?.receipts} />}
          {view?.pending && (
            <PermissionInline
              persistent={app.phase4}
              tool={view.pending.tool}
              summary={view.pending.summary}
              onRespond={s.respond}
            />
          )}
          <PromptLine
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
            cwdLabel={workspace?.name ?? (session ? "scratch" : "~")}
            running={!!view?.running}
            blocked={waiting}
            modelLabel={modelLabel(model, effort)}
            modelColor={
              providerOf(model) === "codex" ? "var(--codex)" : "var(--claude)"
            }
            onSubmit={(text) => s.send(text)}
          />
        </main>
      </div>
    </div>
  );
}
