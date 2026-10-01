// 表示用の1行要約(renderer と main で共有)。
export function summarizeInput(
  tool: string,
  input: unknown,
  clean: (s: string) => string = (s) => s,
  max = 160,
): string {
  let text: string;
  try {
    text = JSON.stringify(input) ?? "";
  } catch {
    text = "";
  }
  text = clean(`${tool} ${text}`).replace(/\s+/g, " ");
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}
