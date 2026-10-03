export interface CommandSuggestion {
  value: string;
  description: string;
  args?: string;
}
export const builtinCommands: CommandSuggestion[] = [
  { value: "/clear", description: "履歴を残して新しい会話を開始" },
  { value: "/resume", args: "[sessionId]", description: "履歴を一覧・再開" },
  {
    value: "/model",
    args: "[provider:model] [effort]",
    description: "モデルを一覧・変更",
  },
  { value: "/cost", description: "通信回数と取得済み使用量を表示" },
  { value: "/init", description: "AGENTS.mdの雛形を作成（上書きなし）" },
  {
    value: "/mode",
    args: "default|acceptEdits|plan",
    description: "権限モードを変更",
  },
  { value: "/stop", description: "LLMに送信せず実行を停止" },
  { value: "/compact", description: "古い会話を圧縮（LLM通信あり）" },
  { value: "/mcp", description: "MCPサーバーの状態と操作" },
  { value: "/undo", description: "直近ターンを確認して巻き戻す" },
  {
    value: "/rewind",
    args: "[n]",
    description: "nターン前まで確認して巻き戻す",
  },
  {
    value: "/phase",
    args: "plan|implement|review",
    description: "作業段階を変更",
  },
  { value: "/review", description: "レビュー段階を実行" },
  { value: "/exit", description: "終了（headlessのみ）" },
];
export function reservedCommand(name: string) {
  return (
    builtinCommands.some((c) => c.value === `/${name}`) ||
    name.startsWith("mcp__")
  );
}
