/** Safe, fixed diagnostics. Never forward exception messages or CLI credentials. */
export class ToolExecutionError extends Error {}

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
