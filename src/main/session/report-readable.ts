/** Human-readable projections of already sanitized records. Never execute model output. */
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const string = (v: unknown) => (typeof v === "string" ? v : "");
const parse = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return v;
  }
};
const tools: Record<string, string> = {
  Read: "ファイルを読む",
  Write: "ファイルを書く",
  Edit: "ファイルを編集する",
  MultiEdit: "同じファイルの複数箇所をまとめて編集する",
  Bash: "コマンドを実行する",
  Grep: "内容を検索する",
  Glob: "ファイルを探す",
  Task: "子エージェントに委託する",
  WebFetch: "ページを取得する",
  WebSearch: "Webを検索する",
  SubmitPlan: "計画を提出する",
  UpdatePlan: "計画の進捗を更新する",
  RequestReview: "レビューを依頼する",
};
const fields: Record<string, string> = {
  path: "対象ファイル",
  command: "コマンド",
  prompt: "依頼内容",
  instructions: "指示",
  agent: "委託先",
  subagent_type: "委託先",
  name: "名前",
  model: "モデル",
  pattern: "検索条件",
  url: "URL",
  query: "検索語",
  content: "内容",
  old_string: "変更前",
  new_string: "変更後",
  oldString: "変更前",
  newString: "変更後",
};
function text(label: string, value: string) {
  if (!value) return "";
  const short = value.length > 1200;
  return `<div class="readable-block"><h4>${escape(label)}</h4><pre>${escape(value.slice(0, 1200))}${short ? "\n…（続きは詳細JSONで確認）" : ""}</pre></div>`;
}
export function toolName(name: string) {
  return Object.hasOwn(tools, name) ? `${name} · ${tools[name]}` : name;
}
export function recordedStatus(summary: string, decision?: string): string {
  const statuses: Record<string, string> = {
    tool_use: "LLMがツールの利用を要求しました。",
    end_turn: "LLMが今回の応答を終了しました。",
    max_tokens: "応答の長さが上限に達しました。",
    refusal: "LLMが応答を拒否しました。",
  };
  if (decision)
    return `記録上の判定：${decision.endsWith("allow") ? "許可" : "拒否またはエラー"}`;
  const status = summary.split(":").at(-1)?.trim() ?? "";
  return Object.hasOwn(statuses, status) ? statuses[status]! : "";
}
function argumentsView(value: unknown) {
  const entries = Object.entries(object(value)).filter(
    ([key, v]) => Object.hasOwn(fields, key) && typeof v === "string",
  );
  return (
    entries.map(([key, v]) => text(fields[key]!, String(v))).join("") ||
    "<p class=meta>引数の詳細はJSON欄にあります。</p>"
  );
}
function resultView(value: unknown) {
  const result = parse(value);
  if (typeof result === "string") return text("結果", result);
  const data = object(result);
  return (
    [
      text("対象ファイル", string(data.path)),
      text("エラー出力", string(data.stderr)),
      text(
        "結果",
        string(data.content) ||
          string(data.summary) ||
          string(data.text) ||
          string(data.output) ||
          string(data.stdout),
      ),
    ].join("") ||
    "<p class=meta>構造化された結果です。詳細JSONで確認できます。</p>"
  );
}
function blocksView(content: unknown, role: unknown): string {
  return list(content)
    .map((value) => {
      const b = object(value);
      switch (b.type) {
        case "text":
          return text(
            role === "assistant" ? "LLMの返答" : "依頼・追加の指示",
            string(b.text),
          );
        case "tool_use":
          return `<div class="tool-request"><h4>LLMが要求した操作：${escape(toolName(string(b.name)))}</h4>${argumentsView(b.input)}</div>`;
        case "tool_result":
          return `<div class="tool-result"><h4>ハーネスから返す実行結果${b.isError === true ? "（エラー）" : ""}</h4>${Array.isArray(b.content) ? blocksView(b.content, "tool") : resultView(b.content)}</div>`;
        case "reasoning":
          return "<p class=meta>推論ブロックがあります。内部の思考全体を表すものではありません。</p>";
        case "compaction":
          return "<p class=meta>圧縮済みの会話を含みます。</p>";
        case "image":
          return `<p class=meta>画像：${escape(string(b.mediaType))} · ${escape(String(b.bytes ?? "不明"))} bytes（本体は記録しません）</p>`;
        default:
          return "<p class=meta>簡易表示に対応していないブロックです。詳細JSONで確認できます。</p>";
      }
    })
    .join("");
}
export function requestView(value: unknown, previous?: unknown) {
  const request = object(value);
  if (!Array.isArray(request.messages))
    return "<p>LLM入力の構造が未記録のため、詳細JSONを確認してください。</p>";
  const messages = request.messages;
  const before = list(object(previous).messages);
  const comparable =
    previous !== undefined &&
    before.length <= messages.length &&
    before.every((m, i) => JSON.stringify(m) === JSON.stringify(messages[i]));
  // Context compaction or provider changes can rewrite the send view; do not invent a delta.
  const added = comparable
    ? messages.slice(before.length)
    : previous === undefined
      ? messages
      : messages.slice(-1);
  const shown = added.length > 4 ? added.slice(-4) : added;
  const explanation = comparable
    ? `前回から追加した情報 ${added.length} 件（送信履歴全体 ${messages.length} 件）`
    : previous === undefined
      ? `初回の入力（送信履歴 ${messages.length} 件）`
      : "履歴の構成が変わっています。最新の入力を表示し、全体は詳細JSONに残しています。";
  const system = string(request.system);
  const names = list(request.tools)
    .map((t) => toolName(string(object(t).name)))
    .filter(Boolean);
  return `<p class=meta>${escape(explanation)}${added.length > shown.length ? "。直近4件を表示" : ""}</p>${shown.map((m) => blocksView(object(m).content, object(m).role)).join("") || "<p>追加メッセージはありません。</p>"}<p class=meta>共通指示：${system.length}文字 · 利用可能なツール：${names.length}種類（詳細JSONに全文）</p>${names.length ? `<details><summary>利用可能な操作</summary><p>${escape(names.join(" / "))}</p></details>` : ""}`;
}
export function responseView(value: unknown) {
  const response = parse(value);
  const m = object(response);
  return Array.isArray(m.content)
    ? blocksView(m.content, "assistant")
    : resultView(response);
}
/** User messages added by the harness are instructions/results, not LLM replies. */
export function messageView(value: unknown) {
  const message = object(parse(value));
  return Array.isArray(message.content)
    ? blocksView(message.content, message.role)
    : receiptOutputView(value);
}
export function receiptInputView(value: unknown) {
  if (value === undefined) return "<p>入力は未記録です。</p>";
  const input = parse(value);
  return typeof input === "string" ? text("内容", input) : argumentsView(input);
}
export function receiptOutputView(value: unknown) {
  return value === undefined ? "<p>出力は未記録です。</p>" : resultView(value);
}
export function initialRequest(messages: unknown[], requests: unknown[]) {
  const source = messages.length
    ? messages
    : requests.flatMap((r) => list(object(r).messages));
  const first = source.find(
    (m) =>
      object(m).role === "user" &&
      list(object(m).content).some((b) => object(b).type === "text"),
  );
  if (!first) return "";
  return `<div class="initial-request"><h3>最初の依頼（保存記録より）</h3>${blocksView(object(first).content, "user")}</div>`;
}
