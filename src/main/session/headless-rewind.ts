import { FileCheckpointStore } from "../checkpoints/store.js";
import { type RewindScope } from "../../shared/rewind.js";
import { rewindRecord } from "./rewind-command.js";
import { type SessionStore } from "./store.js";

/** Local command: every write requires an explicit final confirmation. */
export async function headlessRewind(
  files: FileCheckpointStore,
  sessions: SessionStore,
  sessionId: string,
  count: number,
  question: (prompt: string) => Promise<string>,
  print: (text: string) => void,
  clean: (text: string) => string,
  signal: AbortSignal,
) {
  const plan = await files.preview(sessionId, count);
  print(
    "Bashによる変更とworktreeのworkerは対象外です。元の会話ログは残します。\n",
  );
  for (const file of plan.preview.files)
    print(
      clean(
        `${file.path}：${file.unavailable ?? (file.conflict ? "内容不一致・既定で除外" : "復元対象")}\n`,
      ),
    );
  const answer = (
    await question("復元対象 [code / conversation / both、既定code] ")
  ).trim();
  const scope: RewindScope = answer === "" ? "code" : (answer as RewindScope);
  if (!["code", "conversation", "both"].includes(scope))
    throw new Error("復元対象が不正です。");
  const includeConflicts: string[] = [];
  if (scope !== "conversation")
    for (const file of plan.preview.files)
      if (
        file.conflict &&
        !file.unavailable &&
        (
          await question(
            clean(`${file.path}の外部変更も上書きしますか？ [y/N] `),
          )
        )
          .trim()
          .toLowerCase() === "y"
      )
        includeConflicts.push(file.id);
  if (
    (await question("確認して復元しますか？ [y/N] ")).trim().toLowerCase() !==
      "y" ||
    signal.aborted
  )
    return;
  const result = await files.restore(plan, { scope, includeConflicts }, signal);
  const appliedScope = signal.aborted ? "code" : scope;
  await sessions.append(
    sessionId,
    [
      rewindRecord(
        plan.messages,
        appliedScope,
        result.restored.length,
        result.skipped.length,
      ),
    ],
    clean,
  );
  if (appliedScope !== "code")
    await files.conversationRewound(sessionId, plan, result.restored);
  print(`復元${result.restored.length}件、除外${result.skipped.length}件。\n`);
  return appliedScope;
}
