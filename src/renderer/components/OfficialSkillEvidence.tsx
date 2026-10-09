import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";

const observedStatus = {
  requested: "使用要求",
  allowed: "許可",
  completed: "呼出完了",
  denied: "拒否",
};
export function OfficialSkillEvidence({ record }: { record: WorkflowRecord }) {
  if (!record.calls.some((call) => call.officialSkills)) return null;
  return (
    <details>
      <summary>公式スキルの送信・使用証跡</summary>
      <p>
        選択・実行基盤への送信は、実際に使用した証拠ではありません。観測は取得したスキル呼出の状態で、タスク全体の成功を証明しません。
      </p>
      {record.calls.map((call, index) => (
        <section
          key={call.requestId}
          aria-label={`呼出${index + 1}の公式スキル`}
        >
          <h4>
            #{index + 1} · {call.phase} · {call.provider}
          </h4>
          {call.officialSkills ? (
            <>
              <h5>要求した選択</h5>
              {call.officialSkills.requested.map((skill) => (
                <p key={`${skill.provider}:${skill.source}`}>
                  {skill.name} · {skill.provider} · {skill.scope} ·{" "}
                  {skill.source}
                  <br />
                  本文hash：{skill.hash} / bundle hash：{skill.bundleHash}
                </p>
              ))}
              <h5>実行基盤への送信（使用・完了ではありません）</h5>
              {call.officialSkills.dispatched?.length ? (
                call.officialSkills.dispatched.map((skill, n) => (
                  <p key={n}>
                    {skill.name} · {skill.mechanism}
                  </p>
                ))
              ) : (
                <p>送信の証跡なし</p>
              )}
              <h5>使用の観測</h5>
              {call.officialSkills.observed?.length ? (
                call.officialSkills.observed.map((skill, n) => (
                  <p key={n}>
                    {skill.name} · {observedStatus[skill.status]}
                  </p>
                ))
              ) : (
                <p>使用は未確認</p>
              )}
            </>
          ) : (
            <p>保存記録なし。未使用の証明ではありません。</p>
          )}
        </section>
      ))}
    </details>
  );
}
