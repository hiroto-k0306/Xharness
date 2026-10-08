import { redact } from "../../core/redact.js";

export interface CommunicationText {
  text: string;
  truncated: boolean;
}
export interface WorkflowCommunication {
  boundary: "xharness-official-agent";
  input: CommunicationText;
  output?: CommunicationText;
  events?: import("./public-events.js").PublicEvent[];
  eventsOmitted?: boolean;
}
export const phaseExplanation: Record<string, string> = {
  conversation: "質問に回答、または入力を質問・作業に判別します。",
  plan: "対象とテストを確認し、担当モデルと作業計画を提案します。",
  implement: "承認済みの計画と対象範囲に沿って実装します。",
  fix: "テストやレビューの指摘を受けて修正します。",
  review: "固定した変更差分とテスト結果を別会社のモデルが確認します。",
};
const excluded =
  /^(?:authorization|chatgpt[-_]account[-_]id|account[_-]?id|access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|client[_-]?secret|secret|credentials|thinking|reasoning|encrypted_content|signature)$/i;
function clean(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[深い階層を省略]";
  if (typeof value === "string")
    return redact(value)
      .replace(/\bsk-[A-Za-z0-9_-]+/g, "[除去]")
      .replace(/<(thinking|reasoning)>[\s\S]*?<\/\1>/gi, "[思考本文を除去]")
      .replace(/\bBearer\s+[\w.\-]+/gi, "Bearer [除去]")
      .replace(
        /\b(authorization|chatgpt[-_]account[-_]id|account[_-]?id|access[_-]?token|refresh[_-]?token|token|api[_-]?key|password|client[_-]?secret|secret)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi,
        "$1=[除去]",
      );
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1));
  if (value && typeof value === "object") {
    if (
      "type" in value &&
      [
        "thinking",
        "reasoning",
        "redacted_thinking",
        "image",
        "input_image",
        "audio",
        "input_audio",
      ].includes(String(value.type))
    )
      return "[思考・画像・音声の本体を除去]";
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        excluded.test(key) ? "[除去]" : clean(v, depth + 1),
      ]),
    );
  }
  return value;
}
/** Application snapshots or selected public content only; never raw SDK events. */
export function communicationText(
  value: unknown,
  limit = 24_000,
): CommunicationText {
  const text = JSON.stringify(clean(value), null, 2) ?? "未取得";
  // Do not split a surrogate pair at the display/storage boundary.
  const end = /[\uD800-\uDBFF]/.test(text[limit - 1] ?? "") ? limit - 1 : limit;
  return { text: text.slice(0, end), truncated: text.length > end };
}
export function communicationInput(value: unknown): WorkflowCommunication {
  return {
    boundary: "xharness-official-agent",
    input: communicationText(value),
  };
}
