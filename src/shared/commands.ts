export interface CommandSuggestion {
  value: string;
  description: string;
  args?: string;
}
export const builtinCommands: CommandSuggestion[] = [
  {
    value: "/quota-resume",
    args: "enable|cancel|now",
    description: "保存した利用枠待ちの明示有効化・取消・手動再確認（desktop）",
  },
  {
    value: "/schedule",
    args: "help|after|every|idle|event|list|cancel",
    description: "起動中だけ有効な予約・イベント待ち（発火時にモデル通信）",
  },
  {
    value: "/signal",
    args: "<名前>",
    description: "この会話の名前付きイベントを通知（通信なし）",
  },
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
    args: "通常|自動|計画",
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
