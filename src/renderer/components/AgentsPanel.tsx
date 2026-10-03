import { type SessionView } from "../state/store.js";
import styles from "./Workflow.module.css";
export function AgentsPanel({
  view,
  selected,
  model,
  onSelect,
}: {
  view?: SessionView;
  selected: string;
  model: string;
  onSelect(id: string): void;
}) {
  const agents = Object.values(view?.agents ?? {});
  if (!agents.length && !view?.workflow?.items.length) return null;
  return (
    <div className={styles.agentBar} role="group" aria-label="AgentsPanel">
      <button
        aria-pressed={selected === "auto"}
        onClick={() => onSelect("auto")}
      >
        自動追従
      </button>
      <button
        aria-pressed={selected === "main"}
        onClick={() => onSelect("main")}
      >
        {`main · ${model} · ${
          view?.pending ? "確認待ち" : view?.running ? "running" : "idle"
        }`}
      </button>
      {agents.map((a) => (
        <button
          key={a.agentId}
          aria-pressed={selected === a.agentId}
          title={`STEP ${view?.agentSteps?.[a.agentId]?.step ?? "context"}`}
          onClick={() => onSelect(a.agentId)}
        >
          {`${a.name} · ${a.model} · ${
            view?.pending?.agentId === a.agentId
              ? "確認待ち"
              : a.status === "stopped"
                ? "停止"
                : a.status === "awaiting_user"
                  ? "返答待ち"
                  : a.status
          }${a.branch ? ` · ${a.branch}` : ""}`}
        </button>
      ))}
      {view?.workflow?.items
        .filter((i) => i.status === "pending")
        .map((i) => (
          <small key={i.id}>{`${i.id} · 起動待ち`}</small>
        ))}
    </div>
  );
}
