import type { WorkflowRecord } from "../../main/workflow/official/runtime.js";
export function OfficialPlanPolicy({
  plan,
}: {
  plan: NonNullable<WorkflowRecord["plan"]>;
}) {
  return (
    <section aria-label="計画の実行方式と独立検証">
      {plan.parallelization ? (
        <>
          <p>
            実行方式：
            {plan.parallelization.mode === "parallel" ? "並列" : "直列"} /
            最大同時数：{plan.parallelization.maxParallel}
          </p>
          <p>判断理由：{plan.parallelization.reason}</p>
          {plan.parallelization.conditions?.length ? (
            <p>条件：{plan.parallelization.conditions.join(" / ")}</p>
          ) : null}
          {plan.parallelization.unresolved?.length ? (
            <p>未解決：{plan.parallelization.unresolved.join(" / ")}</p>
          ) : null}
        </>
      ) : (
        <p>実行方式の判断は保存記録にありません。</p>
      )}
      {plan.validation && (
        <p>
          独立検証の対象Nodeテスト：{plan.validation.testFiles.join(", ")}
          。実行前に対象・コマンド・digestを別途確認します。
        </p>
      )}
    </section>
  );
}
