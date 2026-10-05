import { ImprovementEvaluation } from "./ImprovementEvaluation.js";
import { ImprovementBaseline } from "./ImprovementBaseline.js";
import { ModelCandidates } from "./ModelCandidates.js";
import { type ModelCandidateView } from "../../shared/model-candidates.js";
import { useEffect, useRef, useState } from "react";
import { type PendingPermission } from "../state/store.js";
import {
  type ImprovementAction,
  type ImprovementView,
} from "../../shared/improvements.js";
import { PermissionInline } from "./PermissionInline.js";
import styles from "./ProjectMemory.module.css";
import comparisonStyles from "./Improvements.module.css";

export function ImprovementsPanel({
  sessionId,
  workspaceId,
  permission,
  open,
  onOpenChange: setOpen,
}: {
  sessionId: string;
  workspaceId: string;
  permission?: PendingPermission;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const [view, setView] = useState<ImprovementView>(),
    [error, setError] = useState<string>(),
    [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<{
    context: string;
    view: ModelCandidateView;
  }>();
  const [selected, setSelected] = useState(""),
    [versionId, setVersion] = useState(""),
    [caseId, setCase] = useState(""),
    [prompt, setPrompt] = useState("");
  const [candidateName, setCandidateName] = useState(""),
    [candidateBody, setCandidateBody] = useState(""),
    [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  const active = useRef(false),
    generation = useRef(0);
  const operationId = useRef("initial");
  const e = view?.entries.find((e) => e.id === selected),
    v = e?.versions.find((v) => v.id === versionId);
  const command = async (request: ImprovementAction) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError(undefined);
    setPrompt("");
    const seq = ++generation.current;
    operationId.current = `improve-${Date.now()}-${seq}`;
    try {
      const r = await window.harness.command({
        type: "improvements",
        sessionId,
        operationId: operationId.current,
        request,
      });
      if (generation.current !== seq) return;
      if (!r.ok) setError(r.error);
      else {
        if (r.improvements) setView(r.improvements);
        if (r.preparedPrompt) setPrompt(r.preparedPrompt);
        if (
          r.modelCandidates &&
          (request.action === "model_candidates" ||
            request.action === "select_model_candidate")
        )
          setCandidates({
            context: `${request.id}/${request.revision}/${request.versionId}/${request.caseId}`,
            view: r.modelCandidates,
          });
        setConfirmed(false);
      }
    } catch {
      setError("結果を確認できません。再取得してください。");
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  useEffect(
    () => () => {
      generation.current++;
      void window.harness.command({
        type: "improvements",
        sessionId,
        operationId: operationId.current,
        request: { action: "cancel" },
      });
    },
    [sessionId],
  );
  const close = () => {
    setOpen(false);
    setPrompt("");
    if (active.current)
      void window.harness.command({
        type: "improvements",
        sessionId,
        operationId: operationId.current,
        request: { action: "cancel" },
      });
  };
  const choose = (id: string) => {
    setSelected(id);
    const entry = view?.entries.find((e) => e.id === id);
    setVersion(entry?.adopted ?? entry?.versions[0]?.id ?? "");
    setCase(entry?.cases[0]?.id ?? "");
    setPrompt("");
    setConfirmed(false);
  };
  const run = async () => {
    if (!prompt || active.current || !confirmed) return;
    active.current = true;
    setBusy(true);
    try {
      if (!e) throw new Error("比較を再選択してください。");
      operationId.current = `improve-${Date.now()}-${++generation.current}`;
      const fresh = await window.harness.command({
        type: "improvements",
        sessionId,
        operationId: operationId.current,
        request: {
          action: "prepare",
          id: e.id,
          revision: e.revision,
          versionId,
          caseId,
        },
      });
      if (!fresh.ok || !fresh.preparedPrompt)
        throw new Error(
          fresh.ok ? "評価依頼を再準備してください。" : fresh.error,
        );
      const created = await window.harness.command({
        type: "new_session",
        workspaceId,
      });
      if (!created.ok || !created.sessionId)
        throw new Error("新規会話を作成できません。");
      const result = await window.harness.command({
        type: "send",
        sessionId: created.sessionId,
        text: fresh.preparedPrompt,
      });
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "評価依頼を確認してください。自動再送しません。",
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={styles.area}>
      <button
        onClick={() => {
          setOpen(true);
          void command({ action: "list" });
        }}
      >
        改善版の比較
      </button>
      {open && (
        <section
          role="dialog"
          aria-label="改善版の比較"
          className={`${styles.panel} ${comparisonStyles.panel}`}
        >
          <header>
            <strong>改善版の比較・採用・復帰</strong>
            <button onClick={close}>閉じる</button>
            <button
              disabled={busy}
              onClick={() => void command({ action: "list" })}
            >
              再取得
            </button>
            <button
              disabled={!busy}
              onClick={() =>
                void window.harness.command({
                  type: "improvements",
                  sessionId,
                  operationId: operationId.current,
                  request: { action: "cancel" },
                })
              }
            >
              操作を取消
            </button>
          </header>
          <p>
            同じ固定課題・基準・環境で品質を先に確認します。採用は参照版の切替です。通常の設定・SKILL.md・実行中の指示は変更しません。評価実行は通常のモデル通信と許可確認を伴います。模擬結果は本番の優越や最適性を示しません。
          </p>
          {permission && (
            <PermissionInline
              {...permission}
              oneTime
              onRespond={(decision) =>
                void window.harness.command({
                  type: "permission_response",
                  sessionId,
                  requestId: permission.requestId,
                  decision,
                })
              }
            />
          )}
          {error && <p role="alert">{error}</p>}
          <label>
            比較を選択
            <select
              aria-label="比較を選択"
              value={selected}
              onChange={(x) => choose(x.target.value)}
              disabled={busy}
            >
              <option value="">選択してください</option>
              {view?.entries.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          {!e && (
            <ImprovementBaseline
              busy={busy}
              command={command}
              setError={setError}
            />
          )}
          {e && (
            <>
              <p>
                {e.name} / revision {e.revision} / 採用版{" "}
                {e.versions.find((v) => v.id === e.adopted)?.name ?? "未採用"}
              </p>
              <label>
                対象版
                <select
                  aria-label="対象版"
                  value={versionId}
                  disabled={busy}
                  onChange={(x) => {
                    setVersion(x.target.value);
                    setPrompt("");
                    setConfirmed(false);
                  }}
                >
                  {e.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {e.adopted === v.id ? "（採用済み）" : "（候補）"}
                    </option>
                  ))}
                </select>
              </label>
              <p>
                SHA-256 {v?.hash} / 親版 {v?.parent ?? "なし"}
              </p>
              <pre>{v?.body}</pre>
              <details>
                <summary>出典と固定条件</summary>
                <pre>
                  {JSON.stringify(
                    { source: e.source, cases: e.cases },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void command({
                    action: "candidate",
                    id: e.id,
                    revision: e.revision,
                    parent: versionId,
                    name: candidateName,
                    body: candidateBody,
                  });
                }}
              >
                <h3>選択版から新しい候補</h3>
                <input
                  aria-label="候補名"
                  placeholder="候補名"
                  required
                  maxLength={200}
                  value={candidateName}
                  onChange={(x) => setCandidateName(x.target.value)}
                />
                <textarea
                  aria-label="候補本文"
                  required
                  maxLength={8000}
                  value={candidateBody}
                  onChange={(x) => setCandidateBody(x.target.value)}
                />
                <button disabled={busy}>候補版を保存</button>
              </form>
              <label>
                評価課題
                <select
                  aria-label="評価課題"
                  value={caseId}
                  disabled={busy}
                  onChange={(x) => {
                    setCase(x.target.value);
                    setPrompt("");
                  }}
                >
                  {e.cases.map((c) => (
                    <option key={c.id}>{c.id}</option>
                  ))}
                </select>
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  void command({
                    action: "prepare",
                    id: e.id,
                    revision: e.revision,
                    versionId,
                    caseId,
                  })
                }
              >
                評価依頼を準備（通信なし）
              </button>
              {prompt && (
                <>
                  <textarea aria-label="固定評価依頼" readOnly value={prompt} />
                  <button
                    disabled={busy || !confirmed}
                    onClick={() => void run()}
                  >
                    新規会話で評価実行
                  </button>
                </>
              )}
              <ImprovementEvaluation
                key={`${e.id}/${versionId}/${caseId}`}
                e={e}
                versionId={versionId}
                caseId={caseId}
                rows={view?.rows ?? []}
                busy={busy}
                command={command}
              />
              <ModelCandidates
                key={`model-${e.id}/${e.revision}/${versionId}/${caseId}`}
                selection={{
                  id: e.id,
                  revision: e.revision,
                  versionId,
                  caseId,
                }}
                view={
                  candidates?.context ===
                  `${e.id}/${e.revision}/${versionId}/${caseId}`
                    ? candidates.view
                    : undefined
                }
                busy={busy}
                command={command}
              />
              <label>
                切替理由
                <input
                  aria-label="切替理由"
                  maxLength={1000}
                  value={reason}
                  onChange={(x) => setReason(x.target.value)}
                />
              </label>
              <label>
                <input
                  aria-label="操作を明示確認"
                  type="checkbox"
                  disabled={busy}
                  checked={confirmed}
                  onChange={(x) => setConfirmed(x.target.checked)}
                />
                選択版・条件・根拠を確認した（模擬だけでは本番品質を保証しない）
              </label>
              <button
                disabled={busy || !confirmed || !reason.trim()}
                onClick={() =>
                  void command({
                    action: "adopt",
                    id: e.id,
                    revision: e.revision,
                    versionId,
                    reason,
                    confirmed: true,
                  })
                }
              >
                選択版を採用
              </button>
              <button
                disabled={busy || !confirmed || !reason.trim()}
                onClick={() =>
                  void command({
                    action: "restore",
                    id: e.id,
                    revision: e.revision,
                    versionId,
                    reason,
                    confirmed: true,
                  })
                }
              >
                以前の採用版へ復帰
              </button>
              <details>
                <summary>切替履歴</summary>
                <pre>{JSON.stringify(e.history, null, 2)}</pre>
              </details>
            </>
          )}
        </section>
      )}
    </div>
  );
}
