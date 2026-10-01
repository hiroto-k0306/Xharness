import { useEffect, useState } from "react";
import { type AppState, type Effort } from "../../shared/ipc.js";
import styles from "./Workflow.module.css";
interface Item {
  id: string;
  title: string;
  files: string[];
  dependsOn: string[];
  assignee: { agent: string; model: string; effort: Effort; reason: string };
}
export function PlanApproval({
  plan,
  models,
  onApprove,
  onDeny,
  onRevise,
}: {
  plan: unknown[];
  models: NonNullable<AppState["models"]>;
  onApprove(items: unknown[]): void;
  onDeny(): void;
  onRevise(): void;
}) {
  const [items, setItems] = useState(() => structuredClone(plan) as Item[]);
  const change = (index: number, patch: Partial<Item["assignee"]>) =>
    setItems((all) =>
      all.map((item, i) =>
        i === index
          ? { ...item, assignee: { ...item.assignee, ...patch } }
          : item,
      ),
    );
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (
        e.ctrlKey ||
        e.altKey ||
        e.metaKey ||
        e.isComposing ||
        /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName)
      )
        return;
      const key = e.key.toLowerCase();
      if (!["y", "e", "n", "escape"].includes(key)) return;
      e.preventDefault();
      if (key === "y") onApprove(items);
      else if (key === "e") onRevise();
      else onDeny();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [items, onApprove, onDeny, onRevise]);
  return (
    <section className={styles.plan} role="alertdialog" aria-label="計画の承認">
      {items.map((item, index) => {
        const selected = models.find(
          (m) =>
            m.id === item.assignee.model ||
            `${m.provider}:${m.label.toLowerCase().split(" ")[0]}` ===
              item.assignee.model,
        );
        return (
          <article key={item.id}>
            <strong>
              {item.id} · {item.title}
            </strong>
            <div>
              {item.files.join(", ")} · 依存:{" "}
              {item.dependsOn.join(", ") || "なし"}
            </div>
            <select
              aria-label={`${item.id} agent`}
              value={item.assignee.agent}
              onChange={(e) => change(index, { agent: e.target.value })}
            >
              <option>main</option>
              <option>worker</option>
            </select>
            <select
              aria-label={`${item.id} model`}
              value={selected?.id ?? item.assignee.model}
              onChange={(e) =>
                change(index, {
                  model: e.target.value,
                  effort:
                    models.find((m) => m.id === e.target.value)
                      ?.defaultEffort ?? "high",
                })
              }
            >
              {!selected && <option>{item.assignee.model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            {!!selected?.efforts.length && (
              <select
                aria-label={`${item.id} effort`}
                value={item.assignee.effort}
                onChange={(e) =>
                  change(index, { effort: e.target.value as Effort })
                }
              >
                {selected.efforts.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            )}
            <div>{item.assignee.reason}</div>
          </article>
        );
      })}
      <button onClick={() => onApprove(items)}>y 承認</button>
      <button onClick={onRevise}>e 修正を指示</button>
      <button onClick={onDeny}>n 却下</button>
    </section>
  );
}
