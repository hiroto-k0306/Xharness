import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";

/** Saved evidence only: never resolve past calls against today's catalog. */
export function ModelSelectionEvidence({ record }: { record: WorkflowRecord }) {
  if (!record.calls.length) return null;
  return (
    <section aria-label="呼出ごとのモデル解決履歴">
      <h4>呼出ごとのモデル解決履歴</h4>
      {record.calls.map((call, index) => {
        const selection = call.modelSelection;
        return (
          <div key={call.requestId}>
            <p>
              #{index + 1} · {call.phase} · {call.status}
            </p>
            {selection ? (
              <>
                <p>
                  保存policy：{selection.policy.provider}:
                  {selection.policy.model} / effort：
                  {selection.policy.effort ?? "指定なし"}
                </p>
                <p>
                  呼出時の実ID：{selection.resolved.provider}/
                  {selection.resolved.model} / effort：
                  {selection.resolved.effort ?? "指定なし"}
                </p>
                <p>
                  catalog：v{selection.resolved.catalog.version} ·{" "}
                  {selection.resolved.catalog.updatedAt} · digest{" "}
                  {selection.resolved.catalog.digest}
                </p>
                <p>
                  前回との変更：
                  {selection.previous
                    ? selection.changed
                      ? "あり"
                      : "なし"
                    : "前回の解決記録なし"}
                </p>
                {selection.previous && (
                  <p>
                    前回の実ID：{selection.previous.model} / effort：
                    {selection.previous.effort ?? "指定なし"}
                    {selection.previous.catalog && (
                      <>
                        {" "}
                        / catalog：v{selection.previous.catalog.version} ·{" "}
                        {selection.previous.catalog.updatedAt} · digest{" "}
                        {selection.previous.catalog.digest}
                      </>
                    )}
                  </p>
                )}
              </>
            ) : (
              <p>
                当時の指定ID：{call.provider}/{call.requestedModel} / effort：
                {call.effort ?? "指定なし"}（alias
                policy・catalogの保存記録なし）
              </p>
            )}
          </div>
        );
      })}
    </section>
  );
}
