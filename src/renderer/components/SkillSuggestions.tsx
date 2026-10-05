import { type SkillEntry } from "../../shared/project-skills.js";
import {
  SKILL_SUGGESTION_LIMITS as limits,
  suggestProjectSkills,
} from "../../shared/skill-suggestions.js";
interface Props {
  entries?: SkillEntry[];
  request: string;
  draft?: string;
  disabled: boolean;
  onRequest(text: string): void;
  onSelect(entry: SkillEntry): void;
}
export function SkillSuggestions(p: Props) {
  const result = suggestProjectSkills(p.entries ?? [], p.request);
  return (
    <section aria-label="依頼に関連するスキル候補">
      <h3>依頼に関連する候補（最大3件）</h3>
      <p>
        取得済みの名前・説明の語一致だけで選びます。最適性や品質は保証しません。本文の命令は候補選定に使わず、追加のモデル通信・自動読込は行いません。
      </p>
      <label>
        依頼内容・明示キーワード
        <textarea
          aria-label="候補を探す依頼内容"
          rows={2}
          maxLength={limits.requestCharacters}
          value={p.request}
          disabled={p.disabled}
          onChange={(e) => p.onRequest(e.target.value)}
        />
      </label>
      <button
        disabled={p.disabled || !p.draft?.trim()}
        onClick={() =>
          p.onRequest((p.draft ?? "").slice(0, limits.requestCharacters))
        }
      >
        入力中の依頼を使う（先頭500文字）
      </button>
      <p role="status">
        {p.disabled
          ? "実行中は候補の表示・選択を停止しています。"
          : !p.entries
            ? "候補には許可済みの最新一覧が必要です。一覧を取得・更新してください。"
            : !p.request.trim()
              ? "依頼内容や具体的なキーワードを入力してください。"
              : !result.candidates.length
                ? "語が一致する候補はありません。必要なら一覧から選択してください。"
                : `${result.candidates.length}件の候補${result.omitted ? `・他${result.omitted}件は表示を省略` : ""}`}
        {result.limited &&
          " 入力・語数・一覧の上限により一部だけを比較しています。"}
      </p>
      <ul aria-label="スキル候補">
        {result.candidates.map(({ entry, score, reasons }) => (
          <li key={`${entry.source}:${entry.hash}`}>
            <button disabled={p.disabled} onClick={() => p.onSelect(entry)}>
              候補を選択: {entry.name}
            </button>
            <p>
              {entry.description.slice(0, limits.descriptionCharacters)}
              {entry.description.length > limits.descriptionCharacters
                ? "…"
                : ""}
            </p>
            <p>
              簡易関連度 {score} · {reasons.join(" / ")}
            </p>
            <small>
              {entry.source} · SHA-256: {entry.hash}
            </small>
          </li>
        ))}
      </ul>
      <p>
        選択後に出典・hashと本文をプレビューして、既存の「会話でこの版を読み込む」へ進めます。ファイルが変わった場合は再取得・再選択が必要です。
      </p>
    </section>
  );
}
