import { type Message } from "../core/types.js";
import { type RewindChoice } from "../../shared/rewind.js";

/** Historical rewind markers remain readable; no model or UI execution entrypoint. */
export function rewindRecord(
  keep: number,
  scope: RewindChoice["scope"],
  restored: number,
  skipped: number,
): Message {
  return {
    role: "user",
    ...(scope !== "code" ? { meta: { rewind: { keep } } } : {}),
    content: [
      {
        type: "text",
        text: `[巻き戻し] 対象=${scope}、復元${restored}件、除外${skipped}件。Bashによる変更は追跡・復元していません。現在のファイルを読み直して作業してください。`,
      },
    ],
  };
}
