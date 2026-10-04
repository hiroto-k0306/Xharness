// ローカルリンク専用。一般 command API からは起動できない。
export const LOCAL_LINK_CHANNEL = "harness:local-link";

/** Renderer は可否の最終判断をしない。main が URL・実体・ドライブを検証する。 */
export function isFileLink(value: string): boolean {
  return /^file:/i.test(value);
}
