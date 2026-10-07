import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
import { impliedRecordModels } from "../../main/workflow/official/record-compat.js";
import styles from "./OfficialWorkflowPanel.module.css";

type Task = NonNullable<WorkflowRecord["plan"]>["tasks"][number];

/** Read only the saved plan and the same versioned compatibility policy as resume. */
export function OfficialPlanAssignments({
  record,
  task,
}: {
  record: WorkflowRecord;
  task: Task;
}) {
  let reviewer = task.reviewer;
  let provenance = "保存済み計画";
  if (!reviewer) {
    const provider = task.assignee.provider === "claude" ? "codex" : "claude";
    try {
      const fixed = impliedRecordModels(record).reviewers[provider];
      if (fixed) reviewer = { provider, ...fixed, reason: "" };
      provenance = `計画に記録なし：記録形式v${record.version}の固定設定`;
    } catch {
      provenance = `計画に記録なし：記録形式v${record.version}の固定定義なし。推測では補いません。`;
    }
  }
  return (
    <div className={styles.assignments}>
      {(
        [
          ["実装担当", task.assignee, "保存済み計画"],
          ["レビュー担当", reviewer, provenance],
        ] as const
      ).map(([label, assignment, source]) => (
        <section key={label} aria-label={`${task.id} ${label}`}>
          <h5>{label}</h5>
          <dl>
            <dt>provider</dt>
            <dd>{assignment?.provider ?? "未確定"}</dd>
            <dt>モデルID</dt>
            <dd>{assignment?.model ?? "未確定"}</dd>
            <dt>effort</dt>
            <dd>
              {assignment
                ? (assignment.effort ?? "server default（指定なし）")
                : "未確定"}
            </dd>
          </dl>
          <small>{source}</small>
          {assignment?.reason && <p>選択理由：{assignment.reason}</p>}
        </section>
      ))}
    </div>
  );
}
