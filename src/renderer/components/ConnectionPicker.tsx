import { useEffect, useState } from "react";
import type {
  ConnectionChoice,
  ConnectionView,
  SiwcAction,
} from "../../shared/connections.js";
import styles from "./Workflow.module.css";
const statusLabels = {
  unconfigured: "未設定",
  available: "利用可能",
  needs_auth: "認可必要",
};
export function ConnectionPicker({
  views,
  current,
  disabled,
  command,
  accountCommand,
  modelCommand,
}: {
  views: ConnectionView[];
  current: ConnectionChoice;
  disabled: boolean;
  command(
    action: "apply" | "check" | "cancel",
    mode: ConnectionChoice,
  ): Promise<{ ok: boolean; error?: string }>;
  accountCommand?(
    action: SiwcAction,
    account?: string,
  ): Promise<{ ok: boolean; error?: string }>;
  modelCommand?(model: string): Promise<{ ok: boolean; error?: string }>;
}) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState(current),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setSelected(current);
  }, [current]);
  const close = () => {
    if (busy) void command("cancel", selected);
    setOpen(false);
    setSelected(current);
    setError("");
  };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        close();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  });
  const view = views.find((v) => v.mode === selected);
  const runAccount = (action: SiwcAction, key?: string) => {
    setBusy(true);
    setError("");
    void accountCommand?.(action, key)
      .then((r) => {
        if (!r.ok) setError(r.error ?? "接続操作に失敗しました。");
      })
      .finally(() => setBusy(false));
  };
  return (
    <>
      <button
        disabled={disabled}
        onClick={() => {
          setSelected(current);
          setOpen(true);
        }}
      >
        接続方式: {views.find((v) => v.mode === current)?.label ?? current}
      </button>
      {open && (
        <div role="dialog" aria-label="接続方式" className={styles.picker}>
          <label>
            このセッションの接続
            <select
              aria-label="接続方式"
              value={selected}
              disabled={busy || disabled}
              onChange={(e) => setSelected(e.target.value as ConnectionChoice)}
            >
              {views.map((v) => (
                <option key={v.mode} value={v.mode}>
                  {v.label} / {statusLabels[v.status]}
                </option>
              ))}
            </select>
          </label>
          {view && (
            <p role="status">
              {statusLabels[view.status]} — {view.reason}
            </p>
          )}
          {selected === "openai-siwc" && accountCommand && (
            <fieldset disabled={disabled || busy}>
              <legend>ChatGPT plan接続</legend>
              <p>
                ブラウザでアカウント・workspace・XHarness名を確認し、本人確認とplan使用・継続更新を許可します。CLIのログインとは別の認可です。
              </p>
              <a
                href="https://developers.openai.com/siwc/token-sharing-open-source/sign-in"
                target="_blank"
                rel="noreferrer"
              >
                公式の登録・認可手順
              </a>{" "}
              <a
                href="https://chatgpt.com/#settings/Usage"
                target="_blank"
                rel="noreferrer"
              >
                Manage usage
              </a>
              <button onClick={() => runAccount("load")}>
                保存済み接続を確認
              </button>
              <button onClick={() => runAccount("connect")}>
                Continue with ChatGPT
              </button>
              {view?.siwc?.accounts.map((a) => (
                <div key={a.key}>
                  <span>
                    {a.label}
                    {view.siwc?.selected === a.key ? "（選択中）" : ""} /{" "}
                    {a.signedIn
                      ? a.planEnabled
                        ? "plan認可済み"
                        : "plan追加認可が必要"
                      : "サインアウト済み"}
                  </span>
                  <button onClick={() => runAccount("select", a.key)}>
                    選択
                  </button>
                  <button onClick={() => runAccount("connect", a.key)}>
                    再認可・plan追加認可
                  </button>
                  <button onClick={() => runAccount("signout", a.key)}>
                    サインアウト
                  </button>
                </div>
              ))}
              {view?.siwc?.welcome && (
                <div role="status">
                  ChatGPT
                  planを使用します。対象の推論はplanまたはcreditsの利用量に含まれます。
                  <button onClick={() => runAccount("acknowledge")}>
                    Got it
                  </button>
                </div>
              )}
              {view?.status === "available" && (
                <button onClick={() => runAccount("catalog")}>
                  利用可能モデルを確認
                </button>
              )}
              {view?.siwc?.models.map((m) => (
                <button
                  key={m.slug}
                  onClick={() => {
                    setBusy(true);
                    void modelCommand?.(m.slug)
                      .then((r) => {
                        if (!r.ok)
                          setError(r.error ?? "モデルを選択できませんでした。");
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  {m.displayName} / {m.slug} を使用
                </button>
              ))}
            </fieldset>
          )}
          <p>
            新接続は通常テキストのAgent
            Loopのみ。自動選択・レビュー段階・補助通信は未対応です。方式変更は空の新規セッションで行います。
          </p>
          <button
            disabled={busy || disabled}
            onClick={() => {
              setBusy(true);
              void command("apply", selected)
                .then((r) => {
                  if (r.ok) setOpen(false);
                  else setError(r.error ?? "選択に失敗しました。");
                })
                .finally(() => setBusy(false));
            }}
          >
            接続を適用
          </button>
          {selected.startsWith("claude-") && (
            <button
              disabled={busy || disabled}
              onClick={() => {
                setBusy(true);
                void command("check", selected)
                  .then((r) => {
                    if (!r.ok) setError(r.error ?? "確認に失敗しました。");
                  })
                  .finally(() => setBusy(false));
              }}
            >
              公式SDK接続を確認
            </button>
          )}
          {error && <p role="alert">{error}</p>}
          <button onClick={close}>キャンセル</button>
        </div>
      )}
    </>
  );
}
