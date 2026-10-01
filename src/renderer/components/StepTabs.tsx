import { type StepNode, type StepNumber } from "../../shared/ipc.js";
import { STEPS, stepColor } from "../state/steps.js";
import styles from "./StepTabs.module.css";

export interface StepTabsProps {
  active?: {
    step: StepNumber;
    node: StepNode;
    round: number;
    index?: number;
    total?: number;
  };
  /** 権限待ち(STEP 4)。回転を止めて warn 色の明滅にする */
  waiting: boolean;
  model: string;
}

/** 1/6 … 6/6。実行中の STEP は枠を光が回る(§16.3) */
export function StepTabs({ active, waiting, model }: StepTabsProps) {
  return (
    <div className={styles.steps} data-testid="steptabs">
      <span className={styles.label}>
        {active ? (
          <>
            loop <b>{active.round}</b>
          </>
        ) : (
          "idle"
        )}
      </span>
      {STEPS.map((s, i) => {
        const n = (i + 1) as StepNumber;
        const isActive = active?.step === n;
        const state = !active
          ? "idle"
          : isActive
            ? waiting && s.node === "gate"
              ? "waiting"
              : "running"
            : n < active.step
              ? "done"
              : "idle";
        return (
          <div
            key={s.node}
            data-testid={`step-${s.node}`}
            data-state={state}
            aria-current={isActive ? "step" : undefined}
            className={`${styles.step} ${styles[state]} ${
              state === "running"
                ? "running"
                : state === "waiting"
                  ? "waiting"
                  : ""
            }`}
            style={{
              ["--glow" as string]:
                state === "waiting" ? "var(--warn)" : stepColor(s.node, model),
            }}
          >
            <span className={styles.n}>{n}/6</span>
            {s.label}
            {isActive && s.node === "act" && active?.total && active.total > 1
              ? ` (${active.index}/${active.total})`
              : ""}
          </div>
        );
      })}
    </div>
  );
}
