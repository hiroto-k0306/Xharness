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
    <aside className={styles.agents} aria-label="AgentsPanel">
      <strong>Agents</strong>
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
        main · {model}
        <small>
          {view?.pending ? "確認待ち" : view?.running ? "running" : "idle"}
        </small>
      </button>
      {agents.map((a) => (
        <button
          key={a.agentId}
          aria-pressed={selected === a.agentId}
          onClick={() => onSelect(a.agentId)}
        >
          {a.name} · {a.model}
          <small>
            {view?.pending?.agentId === a.agentId ? "確認待ち" : a.status} ·
            STEP {view?.agentSteps?.[a.agentId]?.step ?? "context"}
            {a.branch ? ` · ${a.branch}` : ""}
          </small>
        </button>
      ))}
      {view?.workflow?.items
        .filter((i) => i.status === "pending")
        .map((i) => (
          <div key={i.id}>
            {i.id} · {i.agent ?? "worker"} · {i.model ?? ""}
            <small>起動待ち</small>
          </div>
        ))}
    </aside>
  );
}
