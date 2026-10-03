import { useRef, useState } from "react";
import type { QuestionChoices as Choices } from "../../shared/questions.js";
import styles from "./Transcript.module.css";

export function QuestionChoices({
  question,
  disabled,
  onReply,
}: {
  question: Choices;
  disabled: boolean;
  onReply?: (text: string) => Promise<boolean>;
}) {
  const locked = useRef(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(false);
  async function reply(text: string) {
    if (disabled || locked.current || !onReply) return;
    locked.current = true;
    setSent(true);
    setError(false);
    let accepted = false;
    try {
      accepted = await onReply(text);
    } catch {
      /* 通信失敗でも再選択できる */
    }
    if (!accepted) {
      locked.current = false;
      setSent(false);
      setError(true);
    }
  }
  return (
    <div
      className={styles.question}
      role="group"
      aria-label={question.question}
    >
      <div>{question.question}</div>
      <div className={styles.choices}>
        {question.options.map((option, i) => (
          <button
            key={i}
            disabled={disabled || sent || !onReply}
            onClick={() => void reply(option)}
          >
            {i + 1}. {option}
          </button>
        ))}
      </div>
      <div className={styles.dim}>
        番号や自由な回答を入力欄から送ることもできます。
      </div>
      {error && (
        <div role="alert">
          回答を送信できませんでした。もう一度選択するか、入力欄から送信してください。
        </div>
      )}
    </div>
  );
}
