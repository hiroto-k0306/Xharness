import { useState } from "react";
import {
  type RewindPreview,
  type RewindChoice,
  type RewindScope,
} from "../../shared/rewind.js";
import styles from "./TodoList.module.css";
export function RewindApproval({
  preview,
  onRespond,
}: {
  preview: RewindPreview;
  onRespond(choice: RewindChoice | null): void;
}) {
  const [scope, setScope] = useState<RewindScope>("code");
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  const respond = (choice: RewindChoice | null) => {
    setSent(true);
    onRespond(choice);
  };
  return (
    <section className={styles.list} aria-label="巻き戻しの確認">
      <h3>{preview.turns}ターン前まで巻き戻す</h3>
      <p>
        Bashによる変更とworktreeのworkerの変更は対象外です。元の会話ログは削除しません。
      </p>
      <label>
        復元対象{" "}
        <select
          aria-label="復元対象"
          value={scope}
          disabled={sent}
          onChange={(e) => setScope(e.target.value as RewindScope)}
        >
          <option value="code">コードのみ</option>
          <option value="conversation">会話のみ</option>
          <option value="both">コードと会話</option>
        </select>
      </label>
      <ul>
        {preview.files.map((file) => (
          <li key={file.id}>
            <span className={styles.content}>
              {file.path}
              {file.unavailable
                ? `：復元不可（${file.unavailable}）`
                : file.conflict
                  ? "：内容が変わっています（既定で除外）"
                  : "：復元対象"}
            </span>
            {file.conflict && !file.unavailable && (
              <label>
                <input
                  type="checkbox"
                  disabled={sent || scope === "conversation"}
                  checked={conflicts.includes(file.id)}
                  onChange={(e) =>
                    setConflicts(
                      e.target.checked
                        ? [...conflicts, file.id]
                        : conflicts.filter((id) => id !== file.id),
                    )
                  }
                />
                変更があっても復元
              </label>
            )}
          </li>
        ))}
      </ul>
      {!preview.files.length && (
        <p>この範囲に追跡されたファイル変更はありません。</p>
      )}
      <button
        disabled={sent}
        onClick={() =>
          respond({
            scope,
            includeConflicts: scope === "conversation" ? [] : conflicts,
          })
        }
      >
        確認して復元
      </button>{" "}
      <button disabled={sent} onClick={() => respond(null)}>
        キャンセル
      </button>
    </section>
  );
}
