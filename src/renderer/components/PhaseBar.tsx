import { type SessionView } from "../state/store.js";
import styles from "./Workflow.module.css";
import { providerOf } from "../state/steps.js";
export function PhaseBar({
  view,
  model = "main",
  onPhase,
  onJump,
}: {
  view?: SessionView;
  model?: string;
  onPhase?(phase: string): void;
  onJump(phase: string): void;
}) {
  const w = view?.workflow;
  if (!w || ["off", "classify"].includes(w.phase)) return null;
  const done = w.items.filter((i) => i.status === "integrated").length;
  const active = w.phase === "plan" ? 0 : w.phase === "implement" ? 1 : 2;
  const reviewer = Object.values(view?.agents ?? {}).findLast(
    (a) => a.name === "reviewer",
  );
  return (
    <nav className={styles.phases} aria-label="タスク段階">
      {["plan", "implement", "review"].map((p, i) => (
        <button
          key={p}
          data-active={active === i && w.phase !== "complete"}
          className={
            active === i && w.phase !== "complete" ? "running" : undefined
          }
          style={{
            ["--glow" as string]:
              i === 2 && reviewer && providerOf(reviewer.model) === "codex"
                ? "var(--codex)"
                : "var(--claude)",
          }}
          onClick={() => onJump(p)}
        >
          {w.phase === "complete" || i < active
            ? "✓"
            : i === active
              ? "●"
              : "○"}{" "}
          {i + 1} {p.toUpperCase()}
          <small>
            {i === 0
              ? `${w.items.length} 項目`
              : i === 1
                ? `${done} / ${w.items.length} 項目 · 直列`
                : `round ${w.reviewRound}`}
          </small>
          <small>
            {i === 2
              ? `reviewer · ${reviewer?.model ?? "codex"}`
              : `main · ${model}`}
          </small>
        </button>
      ))}
      {onPhase && (
        <select
          aria-label="段階の操作"
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) onPhase(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">段階を変更…</option>
          <option value="plan">plan</option>
          <option value="implement">implement</option>
          <option value="review">レビューを実行</option>
        </select>
      )}
      {w.phase === "attention" && <span>必須指摘の確認待ち</span>}
    </nav>
  );
}
