import { type SkillEntry } from "./project-skills.js";

export const SKILL_SUGGESTION_LIMITS = {
  requestCharacters: 500,
  entries: 50,
  terms: 16,
  candidates: 3,
  descriptionCharacters: 160,
  reasons: 3,
};
const stop = new Set(
  "please help want need use using make create task skill skills project code coding this that with from have should would could implement fix update request the and for not can you your are also ください お願い します して する した したい ほしい 必要 対応 作業 実装 修正 変更 使用 利用 今回 この その ため こと もの プロジェクト スキル".split(
    " ",
  ),
);
const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
function terms(text: string) {
  return new Set(
    Array.from(
      segmenter.segment(
        text.normalize("NFKC").toLowerCase().replace(/[_-]/g, " "),
      ),
    )
      .filter((s) => s.isWordLike)
      .map((s) => s.segment)
      .filter(
        (s) =>
          !stop.has(s) &&
          s.length <= 64 &&
          (/^[a-z0-9]+$/.test(s) ? s.length >= 3 : s.length >= 2),
      ),
  );
}
export interface SkillSuggestion {
  entry: SkillEntry;
  /** Lexical relevance only, never a probability of success or quality score. */
  score: number;
  reasons: string[];
}
/** Only already permitted metadata. No body, I/O, model, persisted index or command interpretation. */
export function suggestProjectSkills(entries: SkillEntry[], request: string) {
  const limits = SKILL_SUGGESTION_LIMITS;
  const query = Array.from(
    terms(request.slice(0, limits.requestCharacters)),
  ).slice(0, limits.terms);
  const matches: SkillSuggestion[] = [];
  for (const entry of entries.slice(0, limits.entries)) {
    const name = terms(entry.name.slice(0, 64));
    const description = terms(entry.description.slice(0, 1024));
    const reasons: string[] = [];
    let score = 0;
    for (const term of query) {
      if (name.has(term)) {
        score += 3;
        reasons.push(`名前の語一致:「${term.slice(0, 32)}」`);
      } else if (description.has(term)) {
        score++;
        reasons.push(`説明の語一致:「${term.slice(0, 32)}」`);
      }
    }
    if (score)
      matches.push({ entry, score, reasons: reasons.slice(0, limits.reasons) });
  }
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      (a.entry.source < b.entry.source
        ? -1
        : a.entry.source > b.entry.source
          ? 1
          : 0),
  );
  return {
    candidates: matches.slice(0, limits.candidates),
    omitted: Math.max(0, matches.length - limits.candidates),
    limited:
      request.length > limits.requestCharacters ||
      terms(request.slice(0, limits.requestCharacters)).size > limits.terms ||
      entries.length > limits.entries,
  };
}
