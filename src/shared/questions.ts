export interface QuestionChoices {
  question: string;
  options: string[];
}

/** 表示用。失敗した呼び出しの候補は描画しない。 */
export function parseQuestionChoices(
  input: unknown,
): QuestionChoices | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const { question, options } = input as Record<string, unknown>;
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 4000 ||
    !Array.isArray(options) ||
    options.length < 2 ||
    options.length > 5 ||
    options.some((o) => typeof o !== "string" || !o.trim() || o.length > 300)
  )
    return;
  return { question, options: [...options] as string[] };
}
