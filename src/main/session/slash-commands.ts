import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { reservedCommand } from "../../shared/commands.js";
import { type Receipt } from "../../shared/ipc.js";
import { type LlmCalls } from "../../shared/llm-calls.js";

export interface UserCommand {
  name: string;
  body: string;
  source: "user" | "project";
}
// Flat regular files only: links and oversized/unreadable definitions never execute.
async function definitions(
  base: string,
  source: UserCommand["source"],
): Promise<UserCommand[]> {
  const folder = join(base, "commands");
  try {
    for (const path of [base, folder]) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) return [];
    }
    const result: UserCommand[] = [];
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const match = /^([\p{L}\p{N}_-]+)\.md$/u.exec(entry.name);
      if (!match || !entry.isFile() || reservedCommand(match[1]!)) continue;
      try {
        const path = join(folder, entry.name);
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024)
          continue;
        const body = await readFile(path, "utf8");
        if (body.trim() && Buffer.byteLength(body) <= 1024 * 1024)
          result.push({ name: match[1]!, body, source });
      } catch {
        /* A damaged definition must not disable other commands. */
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
export async function userCommands(
  home: string,
  cwd?: string,
  trusted = false,
) {
  const commands = new Map(
    (await definitions(home, "user")).map((c) => [c.name, c]),
  );
  if (cwd && trusted)
    for (const command of await definitions(join(cwd, ".xharness"), "project"))
      commands.set(command.name, command);
  return [...commands.values()];
}
export async function hasProjectCommands(cwd: string) {
  return (await definitions(join(cwd, ".xharness"), "project")).length > 0;
}
export function expandCommand(
  text: string,
  commands: UserCommand[],
): string | undefined {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const command = commands.find((c) => c.name === match?.[1]);
  return command?.body.replaceAll("$ARGUMENTS", () => match?.[2] ?? "");
}
export const agentsTemplate = `# AGENTS.md

## プロジェクト概要
目的と主要な構成を記入してください。

## 開発・検証
ビルド、テスト、lintのコマンドを記入してください。

## 作業ルール
- 変更前に対象ファイルと設計を確認する。
- 秘密情報をログやコミットに含めない。
- 変更後に関連する検証を行い、未確認事項を報告する。
`;
export async function initAgents(cwd: string, readOnly: boolean) {
  if (readOnly)
    return {
      ok: false as const,
      error: "読み取り専用・planモードでは/initを実行できません。",
    };
  try {
    await writeFile(join(cwd, "AGENTS.md"), agentsTemplate, { flag: "wx" });
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error:
        (error as NodeJS.ErrnoException).code === "EEXIST"
          ? "AGENTS.mdは既にあります。上書きしません。"
          : "AGENTS.mdを作成できませんでした。",
    };
  }
}
export function costSummary(calls: LlmCalls, receipts: Receipt[]) {
  // Each model_call receipt represents one call; cached counts are included in inputTokens.
  const tokens = receipts
    .filter((r) => r.kind === "model_call")
    .reduce(
      (sum, r) => ({
        input: sum.input + (r.usage?.inputTokens ?? 0),
        output: sum.output + (r.usage?.outputTokens ?? 0),
      }),
      { input: 0, output: 0 },
    );
  return `通信回数：今ターン ${calls.turn - calls.simulatedTurn}、セッション ${calls.session - calls.simulatedSession}\n模擬通信：今ターン ${calls.simulatedTurn}、セッション ${calls.simulatedSession}\n取得済みレシートのトークン合計：入力 ${tokens.input}、出力 ${tokens.output}（未取得分は含まない）。金額は算出しません。`;
}
