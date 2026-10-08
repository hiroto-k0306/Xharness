import type { WorkflowCommunication } from "../../main/workflow/official/communication.js";
import {
  publicActors,
  publicKinds,
} from "../../main/workflow/official/public-events.js";

export function OfficialPublicEvents({
  communication,
}: {
  communication?: WorkflowCommunication;
}) {
  const events = communication?.events;
  return (
    <details>
      <summary>公開イベントの時系列（{events?.length ?? 0}件）</summary>
      <p>
        取得した順序です。全内部往復・完全な送信JSONを再現するものではありません。
      </p>
      {communication?.eventsOmitted && (
        <p>保存上限のため、一部のイベントを省略しました。</p>
      )}
      {!events?.length && (
        <p>
          公開イベントは未取得・未保存です。処理がなかったとは判断しません。
        </p>
      )}
      <ol>
        {events?.map((e, i) => (
          <li
            key={e.sequence ?? i}
            style={{
              borderLeft: `3px solid ${e.actor === "llm" ? "var(--claude)" : e.actor === "tool" ? "var(--codex)" : "var(--warn)"}`,
              paddingLeft: 8,
            }}
          >
            <b>
              #{e.sequence ?? i + 1} {publicActors[e.actor]} —{" "}
              {publicKinds[e.kind]}
            </b>
            <p>
              {e.at ?? "時刻不明"} / {e.name ?? e.model ?? ""} /{" "}
              {e.status ?? "状態未提供"}
            </p>
            <p>
              項目ID: {e.itemId ?? "未提供"} / 親ツールID:{" "}
              {e.parentId === null ? "主系列" : (e.parentId ?? "未提供")}
            </p>
            {e.body ? (
              <>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    maxHeight: 240,
                    overflow: "auto",
                  }}
                >
                  {e.body.text}
                </pre>
                {e.body.truncated && <p>本文の末尾を省略しています。</p>}
              </>
            ) : (
              (e.kind === "response" || e.kind === "tool_result") && (
                <p>本文は提供されていません。</p>
              )
            )}
          </li>
        ))}
      </ol>
    </details>
  );
}
