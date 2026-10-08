import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
import { phaseExplanation } from "../../main/workflow/official/communication.js";

export function OfficialCommunication({ record }: { record: WorkflowRecord }) {
  return (
    <section aria-label="LLMの入力と応答">
      <h3>LLMの入力と応答</h3>
      <p>
        ハーネスから公式実行基盤へ渡した入力と構造化応答です。秘密値・思考本文は除去し、基盤内部の全通信は記録しません。
      </p>
      {record.calls.map((call, i) => (
        <details key={call.requestId}>
          <summary>
            #{i + 1} {phaseExplanation[call.phase] ?? call.phase}（
            {call.provider} / {call.status}）
          </summary>
          <p>
            要求ID: {call.requestId} / 指定モデル: {call.requestedModel}
          </p>
          {call.communication ? (
            <>
              <h4>LLMへの入力（指示・参考データ）</h4>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  maxHeight: 360,
                  overflow: "auto",
                }}
              >
                {call.communication.input.text}
              </pre>
              {call.communication.input.truncated && (
                <p>保存上限のため入力の末尾を省略しています。</p>
              )}
              <h4>LLMからの応答（構造化結果）</h4>
              {call.communication.output ? (
                <>
                  <pre
                    style={{
                      whiteSpace: "pre-wrap",
                      overflowWrap: "anywhere",
                      maxHeight: 360,
                      overflow: "auto",
                    }}
                  >
                    {call.communication.output.text}
                  </pre>
                  {call.communication.output.truncated && (
                    <p>保存上限のため応答の末尾を省略しています。</p>
                  )}
                </>
              ) : (
                <p>応答本文は未取得・未保存です。完了と推測しません。</p>
              )}
            </>
          ) : (
            <p>
              この呼び出しの本文記録はありません。過去の内容は補完しません。
            </p>
          )}
        </details>
      ))}
      {!record.calls.length && <p>呼び出しは未記録です。</p>}
    </section>
  );
}
