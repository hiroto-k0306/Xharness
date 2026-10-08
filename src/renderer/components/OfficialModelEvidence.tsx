import type { AgentDiagnostics } from "../../main/workflow/official/diagnostics.js";

export function OfficialModelEvidence({ data }: { data: AgentDiagnostics }) {
  const main = [
    ...new Set(
      data.assistants
        .filter((a) => a.parentToolUseId === null)
        .map((a) => a.model ?? "不明"),
    ),
  ];
  const expected = data.resolvedRequestedModel ?? data.sdkInitialModels[0];
  const mismatch =
    expected && main.some((model) => model !== expected && model !== "不明");
  return (
    <section aria-label="モデルの観測結果">
      <p>
        SDK：{data.sdkVersion ?? "欠測"} / 付属CLI：{data.cliVersion ?? "欠測"}{" "}
        / モデル変更通知：
        {JSON.stringify(data.modelChanges ?? [])}
        （通知なしは変更なしの証明ではありません）
      </p>
      <p>
        指定モデル：{data.requestedModel} / 解決済みID：
        {data.resolvedRequestedModel ?? "欠測"}
      </p>
      <p>SDK初期モデル：{data.sdkInitialModels.join(", ") || "欠測"}</p>
      <p>主系列assistant（parent=null）：{main.join(", ") || "欠測"}</p>
      {mismatch && (
        <p role="alert">
          モデル不一致：主応答のモデルが指定・初期化の記録と異なります。変更の理由はこの記録だけでは判定できません。
        </p>
      )}
      <p>
        補助系列（parentあり）：
        {data.assistants
          .filter(
            (a) =>
              a.parentToolUseId !== null && a.parentToolUseId !== "unknown",
          )
          .map((a) => `${a.model ?? "不明"} (${a.parentToolUseId})`)
          .join(", ") || "観測なし"}
      </p>
      <p>
        parent欠測：
        {data.assistants.filter((a) => a.parentToolUseId === "unknown").length}
        件
      </p>
      <p>resultモデル別使用量（合計への再加算なし）</p>
      <pre>{JSON.stringify(data.resultModelUsage, null, 2)}</pre>
    </section>
  );
}
