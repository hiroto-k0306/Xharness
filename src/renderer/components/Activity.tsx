import { useEffect, useRef, useState } from "react";
import { type Receipt, type UiEvent, type AppState } from "../../shared/ipc.js";
import { type SessionView } from "../state/store.js";
import { STEPS, stepColor } from "../state/steps.js";
import { Logo } from "./Logo.js";
import styles from "./Activity.module.css";
import { buildReceiptReplay, type ReceiptReplay } from "../../shared/replay.js";
import { ReceiptReplayDialog } from "./ReceiptReplay.js";
import { TodoList } from "./TodoList.js";
import { parseTodos } from "../../shared/todos.js";
type Usage = Partial<
  Record<"claude" | "codex", Extract<UiEvent, { type: "usage" }>>
>;
export function Hero({
  model,
  view,
  open,
  onToggle,
}: {
  model: string;
  view?: SessionView;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <section className={styles.hero} aria-label="session overview">
      <button onClick={onToggle} aria-expanded={open} title="Hero (Ctrl+H)">
        {open ? "▾" : "▸"} overview
      </button>
      {open && (
        <>
          <h1>
            <Logo size={24} /> HARNESS
          </h1>
          <p>Claude plans, GPT builds, code decides.</p>
          <span>
            {model} · main · steps {view?.stepCount ?? 0} ·{" "}
            {view?.running ? "● live" : "idle"}
          </span>
        </>
      )}
    </section>
  );
}
export function LoopFlow({
  view,
  model,
}: {
  view?: SessionView;
  model: string;
}) {
  return (
    <aside className={styles.flow} aria-label="agent loop">
      {STEPS.map((step, index) => {
        const active = view?.step?.node === step.node;
        const waiting = active && step.node === "gate" && !!view?.pending;
        return (
          <div
            key={step.node}
            aria-current={active ? "step" : undefined}
            className={`${styles.node} ${active ? (waiting ? "waiting" : "running") : ""}`}
            style={{
              ["--glow" as string]: waiting
                ? "var(--warn)"
                : stepColor(step.node, model),
            }}
          >
            <b style={{ color: stepColor(step.node, model) }}>
              {index + 1}/6 {step.label}
            </b>
            <div>owner: {step.node === "model" ? model : "harness"}</div>
            <div>
              # {waiting ? "approval required" : active ? "running" : "ready"}
            </div>
          </div>
        );
      })}
    </aside>
  );
}
export function Receipts({
  receipts = [],
  sessionId,
  running = false,
}: {
  receipts?: Receipt[];
  sessionId?: string;
  running?: boolean;
}) {
  const [selected, setSelected] = useState<Receipt>();
  const [replay, setReplay] = useState<ReceiptReplay>();
  const [replayError, setReplayError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState("");
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(undefined);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);
  return (
    <section className={styles.receipts} aria-label="receipts">
      <div className={styles.heading}>
        receipts · {receipts.length}
        {sessionId && (
          <button
            className={styles.replayButton}
            disabled={running || exporting}
            onClick={async () => {
              setExporting(true);
              setExportStatus("");
              try {
                const result = await window.harness.command({
                  type: "export_report",
                  sessionId,
                });
                setExportStatus(
                  result.ok
                    ? "HTMLを保存しました"
                    : result.error === "cancelled"
                      ? ""
                      : result.error,
                );
              } catch {
                setExportStatus("レポートを保存できませんでした");
              } finally {
                setExporting(false);
              }
            }}
          >
            HTML出力
          </button>
        )}
        {exportStatus && <span role="status">{exportStatus}</span>}
        <button
          className={styles.replayButton}
          disabled={!receipts.length}
          onClick={() => {
            try {
              setReplay(buildReceiptReplay(receipts));
              setSelected(undefined);
              setReplayError("");
            } catch {
              setReplayError("記録が大きすぎるため再生できません");
            }
          }}
        >
          再生
        </button>
        {replayError && <span role="status">{replayError}</span>}
      </div>
      <div className={styles.rows}>
        {receipts.slice(-100).map((r) => (
          <button
            key={r.id}
            className={styles.row}
            onClick={() => setSelected(r)}
          >
            <span>{r.id}</span>
            <span>{r.provider}</span>
            <span>{r.tool ?? r.kind}</span>
            <span>{r.decision ?? "—"}</span>
            <span>{r.durationMs}ms</span>
            <span>
              {r.usage
                ? `${r.usage.inputTokens}/${r.usage.outputTokens} tok`
                : "—"}
            </span>
          </button>
        ))}
      </div>
      {replay && (
        <ReceiptReplayDialog
          replay={replay}
          onClose={() => setReplay(undefined)}
        />
      )}
      {selected && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="receipt details"
          className={styles.details}
        >
          <button autoFocus onClick={() => setSelected(undefined)}>
            close
          </button>
          <b>
            {selected.id} · {selected.summary}
          </b>
          <pre>{JSON.stringify(selected.input ?? {}, null, 2)}</pre>
          {selected.tool === "TodoWrite" && parseTodos(selected.input) && (
            <TodoList todos={parseTodos(selected.input)!} />
          )}
          <pre>{selected.output ?? ""}</pre>
        </div>
      )}
    </section>
  );
}
export function UsagePopover({
  usage = {},
  fallback,
  open,
  onToggle,
  onClose,
}: {
  usage?: Usage;
  fallback?: AppState["fallback"];
  open: boolean;
  onToggle(): void;
  onClose(): void;
}) {
  const seen = useRef(new Set<string>());
  const [toast, setToast] = useState("");
  const [now, setNow] = useState(Date.now);
  const container = useRef<HTMLDivElement>(null);
  const values = Object.values(usage)
    .flatMap((u) => [u?.window5h, u?.weekly])
    .filter((v): v is number => v !== undefined);
  const maximum = values.length ? Math.max(...values) : undefined;
  const color = (n?: number) =>
    n === undefined
      ? "var(--dim)"
      : n >= 95
        ? "var(--err)"
        : n >= 80
          ? "var(--warn)"
          : "var(--code)";
  useEffect(() => {
    for (const [provider, u] of Object.entries(usage))
      for (const w of u?.windows ?? []) {
        const key = `${provider}:${w.name}:${w.resetAt ?? "unknown"}`;
        if ((w.usedPercent ?? 0) > 95 && !seen.current.has(key)) {
          seen.current.add(key);
          setToast(`${provider} ${w.name}: ${w.usedPercent}%`);
        }
      }
  }, [usage]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, [open]);
  useEffect(() => {
    const dismiss = (e: MouseEvent) => {
      if (open && !container.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", dismiss);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", dismiss);
      window.removeEventListener("keydown", key);
    };
  }, [open, onClose]);
  const reset = (iso?: string) => {
    if (!iso) return "取得不可";
    const minutes = Math.max(0, Math.ceil((Date.parse(iso) - now) / 60000));
    return Number.isFinite(minutes)
      ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
      : "取得不可";
  };
  return (
    <div ref={container} className={styles.usage}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        title="Usage (Ctrl+U)"
        style={{ color: color(maximum) }}
      >
        ◔ usage {maximum === undefined ? "—" : `${maximum}%`} ▾
      </button>
      {open && (
        <div className={styles.pop} role="dialog" aria-label="usage">
          {(["claude", "codex"] as const).map((provider) => (
            <section key={provider}>
              <b>{provider}</b>
              {(
                [
                  ["5h", 300, usage[provider]?.window5h],
                  ["weekly", 10080, usage[provider]?.weekly],
                ] as const
              ).map(([name, duration, used]) => {
                const w = usage[provider]?.windows?.find(
                  (w) => w.windowMinutes === duration,
                );
                return (
                  <div key={name}>
                    {name}:{" "}
                    <span style={{ color: color(used) }}>
                      {used === undefined ? "取得不可" : `${used}%`}
                    </span>
                    {used === undefined ? (
                      <div>—</div>
                    ) : (
                      <progress
                        max={100}
                        value={used}
                        aria-label={`${provider} ${name}`}
                      />
                    )}
                    reset: {reset(w?.resetAt)}
                  </div>
                );
              })}
              <small>fallback: {fallback?.[provider] ?? "off"}</small>
            </section>
          ))}
        </div>
      )}
      {toast && (
        <div role="status" className={styles.toast}>
          {toast}
          <button onClick={() => setToast("")}>×</button>
        </div>
      )}
    </div>
  );
}
