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

/** ツールカードを開いたときに見せる入力の全文。command があればそのまま、なければ整形した JSON。 */
export function detailInput(
  tool: string,
  input: unknown,
  clean: (s: string) => string = (s) => s,
  max = 4000,
): string {
  void tool;
  let text: string;
  const command =
    input && typeof input === "object"
      ? (input as { command?: unknown }).command
      : undefined;
  if (typeof command === "string") text = command;
  else {
    try {
      text = JSON.stringify(input, null, 2) ?? "";
    } catch {
      text = "";
    }
  }
  text = clean(text);
  return text.length > max ? text.slice(0, max) + "\n…(省略)" : text;
}
