/** Safe, fixed diagnostics. Never forward exception messages or CLI credentials. */
export type ErrorKind =
  | "missing_cli"
  | "not_found"
  | "denied"
  | "timeout"
  | "aborted"
  | "invalid_args"
  | "failed";
export interface ToolFailure {
  kind: ErrorKind;
  message: string;
}
export class ToolExecutionError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind = "failed",
  ) {
    super(message);
  }
}
const messages: Record<ErrorKind, string> = {
  missing_cli:
    "必要なCLIが見つかりません。インストール後にアプリを再起動してください。",
  not_found:
    "対象のファイルまたはフォルダが存在しません。ワークスペースとパスを確認してください。",
  denied: "操作が拒否されました。アクセス権限と承認内容を確認してください。",
  timeout: "実行時間の上限に達しました。対象や処理を絞ってください。",
  aborted: "ユーザーの操作で中断しました。",
  invalid_args:
    "ツールの引数または実行条件が不正です。入力を確認してください。",
  failed: "ツールの実行に失敗しました。",
};
export function failure(kind: ErrorKind): ToolFailure {
  return { kind, message: messages[kind] };
}
export function structuredFailure(error: unknown): ToolFailure {
  if (error instanceof ToolExecutionError)
    return { kind: error.kind, message: error.message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return failure(
    code === "ENOENT" || code === "ENOTDIR"
      ? "not_found"
      : code === "EACCES" || code === "EPERM"
        ? "denied"
        : code === "ETIMEDOUT"
          ? "timeout"
          : code === "EISDIR"
            ? "invalid_args"
            : (error as Error)?.name === "AbortError"
              ? "aborted"
              : "failed",
  );
}

export function toolFailure(error: unknown): string {
  if (error instanceof ToolExecutionError) return error.message;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT")
    return "対象のファイルまたはフォルダが存在しません。ワークスペースとパスを確認してください。";
  if (code === "EACCES" || code === "EPERM")
    return "ファイルまたはフォルダへのアクセス権限がありません。";
  if (code === "EISDIR")
    return "ファイルの代わりにフォルダが指定されています。";
  if (code === "ENOTDIR")
    return "指定パスの途中にフォルダではない項目があります。";
  return "ツールの実行に失敗しました。";
}
