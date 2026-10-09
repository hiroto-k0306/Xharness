import { useEffect, useState } from "react";
import { type AppState, type Effort } from "../../shared/ipc.js";
import styles from "./Workflow.module.css";
export function ModelPicker({
  models,
  model,
  effort,
  onApply,
  onDefault,
  onClose,
  aliasPolicies = false,
}: {
  models: NonNullable<AppState["models"]>;
  model: string;
  effort: Effort;
  onApply(model: string, effort?: Effort): Promise<void>;
  onDefault?(model: string, effort?: Effort): Promise<void>;
  onClose(): void;
  aliasPolicies?: boolean;
}) {
  const policy = (x: (typeof models)[number]) =>
    aliasPolicies && x.alias ? `${x.provider}:${x.alias}` : x.id;
  const choices = aliasPolicies ? models.filter((x) => x.alias) : models;
  const initialModel = choices.find(
    (x) =>
      x.id === model.split(":").at(-1) ||
      policy(x) === model ||
      x.alias === model,
  );
  const [selected, setSelected] = useState(
      initialModel ? policy(initialModel) : "",
    ),
    [level, setLevel] = useState(effort);
  const m = choices.find((x) => policy(x) === selected);
  const effectiveLevel = m?.efforts.includes(level)
    ? level
    : (m?.defaultEffort ?? m?.efforts[0]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [onClose]);
  return (
    <div role="dialog" aria-label="ModelPicker" className={styles.picker}>
      <label>
        モデル
        <select
          aria-label="モデル"
          value={selected}
          onChange={(e) => {
            setSelected(e.target.value);
            setLevel(
              choices.find((x) => policy(x) === e.target.value)
                ?.defaultEffort ?? "high",
            );
          }}
        >
          {!m && (
            <option value="">現在のモデルは選択できません：{model}</option>
          )}
          {choices.map((x) => (
            <option key={x.id} value={policy(x)}>
              {aliasPolicies
                ? `${policy(x)} → ${x.id}`
                : `${x.provider} · ${x.label}`}
            </option>
          ))}
        </select>
      </label>
      {aliasPolicies && (
        <p>
          次の呼出時にaliasの最新IDを解決します。保存済み呼出の実IDは変更しません。
        </p>
      )}
      {m?.efforts.length ? (
        <label>
          effort
          <select
            aria-label="effort"
            value={effectiveLevel}
            onChange={(e) => setLevel(e.target.value as Effort)}
          >
            {m.efforts.map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
        </label>
      ) : (
        <p>effort 指定なし</p>
      )}
      <button
        disabled={!m}
        onClick={() =>
          void onApply(selected, m?.efforts.length ? effectiveLevel : undefined)
        }
      >
        apply · このセッション
      </button>
      {onDefault && (
        <button
          disabled={!m}
          onClick={() =>
            void onDefault(
              selected,
              m?.efforts.length ? effectiveLevel : undefined,
            )
          }
        >
          既定にする
        </button>
      )}
      <button onClick={onClose}>閉じる</button>
    </div>
  );
}
