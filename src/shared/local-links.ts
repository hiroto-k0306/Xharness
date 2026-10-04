// ローカルリンク専用。一般 command API からは起動できない。
export const LOCAL_LINK_CHANNEL = "harness:local-link";

/** Renderer は可否の最終判断をしない。main が URL・実体・ドライブを検証する。 */
export function isFileLink(value: string): boolean {
  return /^file:/i.test(value);
}

/** 明示 Markdown のドライブ絶対リンクだけを補正。起動可否は main が判断する。 */
export function normalizeFileLink(value: string): string {
  if (!/^[a-z]:\//i.test(value)) return value;
  try {
    const segments = value
      .slice(3)
      .split("/")
      .map((part) => {
        const decoded = decodeURIComponent(part);
        // 区切りのエンコードや dot segment を展開して別の場所を指さない。
        if (decoded === "." || decoded === ".." || /[/\\\p{Cc}]/u.test(decoded))
          throw new Error("Invalid link segment");
        return encodeURIComponent(decoded).replace(
          /[!'()*]/g,
          (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
        );
      });
    return `file:///${value.slice(0, 3)}${segments.join("/")}`;
  } catch {
    // 不正なエンコードは推測で直さず、元の（非 file）形式を保つ。
    return value;
  }
}
