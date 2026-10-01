import { useEffect } from "react";
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
        workspaceName={workspace?.name}
        branch={workspace?.branch}
        pickerOpen={prefs.pickerOpen}
        onTogglePicker={() => s.setPrefs({ pickerOpen: !prefs.pickerOpen })}
        fake={app.fake}
      />
      {prefs.pickerOpen && (
        <WorkspacePicker
          workspaces={app.workspaces}
          currentId={session?.workspaceId ?? null}
          onPickFolder={s.pickFolder}
          onStart={(id, readOnly) => void s.newSession(id, readOnly)}
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
          <StepTabs active={view?.step} waiting={waiting} model={model} />
          <Transcript
            items={view?.items ?? []}
            running={!!view?.running}
            model={model}
          />
          {view?.pending && (
            <PermissionInline
              tool={view.pending.tool}
              summary={view.pending.summary}
              onRespond={s.respond}
            />
          )}
          <PromptLine
            cwdLabel={workspace?.name ?? (session ? "scratch" : "~")}
            running={!!view?.running}
            blocked={waiting}
            modelLabel={modelLabel(model, effort)}
            modelColor={
              providerOf(model) === "codex" ? "var(--codex)" : "var(--claude)"
            }
            onSubmit={(text) => void s.send(text)}
          />
        </main>
      </div>
    </div>
  );
}
