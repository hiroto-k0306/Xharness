import type { SdkRuntimeView } from "../../shared/sdk-runtime.js";
export function ClaudeSdkStatus({ runtime }: { runtime?: SdkRuntimeView }) {
  if (!runtime) return null;
  return (
    <section aria-label="Claude SDKの更新状態">
      <h3>Claude SDK</h3>
      {runtime.root && <p>管理フォルダー：{runtime.root}</p>}
      <p>次のタスクで使う版：{runtime.version ?? "準備できていません"}</p>
      <p>更新候補：{runtime.candidate ?? "未確認"}</p>
      <p>
        最終確認：
        {runtime.checkedAt
          ? new Date(runtime.checkedAt).toLocaleString()
          : "未確認"}
      </p>
      <p role={runtime.state === "attention" ? "alert" : "status"}>
        {runtime.message}
      </p>
      <p>
        起動中に24時間ごとに更新を確認します。実行中のタスクは開始時の版を使います。
      </p>
    </section>
  );
}
