import { PersonalApprovalError } from "../../connections/personal-sdk.js";
import { WorkflowFailure } from "./contracts.js";

/** Only application-owned reasons/codes; never native stderr, account fields or raw errors. */
export function connectionFailure(
  provider: "claude" | "codex",
  error: unknown,
) {
  const stage =
    provider === "claude" ? "公式Claude接続確認" : "公式Codex接続確認";
  if (error instanceof PersonalApprovalError)
    return `${stage}: ${error.reason}`;
  if (
    error instanceof WorkflowFailure &&
    /^[a-zA-Z0-9:/_-]{1,100}$/.test(error.code)
  )
    return `${stage}: ${error.code}。モデル入力は送信していません。`;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (["EACCES", "EPERM", "ENOENT"].includes(String(code)))
    return `${stage}: ${code}。権限・実行ファイルを確認してください。モデル入力は送信していません。`;
  return `${stage}: 公式プロセスの確認を完了できません。モデル入力は送信していません。`;
}
