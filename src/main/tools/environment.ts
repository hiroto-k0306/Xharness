import { access, stat, readdir, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export interface EnvironmentReport {
  cli: Record<"rg" | "pwsh" | "git", boolean>;
  workspace: { exists: boolean; readable: boolean; writable: boolean };
  warnings: string[];
  summary: string;
}
/** PATH lookup only; never runs a shell or prints PATH/credentials. */
export async function cliAvailable(name: string): Promise<boolean> {
  const extensions = process.platform === "win32" ? [".exe", ""] : [""];
  for (const directory of (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    if (!isAbsolute(directory.replace(/^"|"$/g, ""))) continue;
    for (const extension of extensions) {
      const path = join(directory.replace(/^"|"$/g, ""), name + extension);
      try {
        if (!(await stat(path)).isFile()) continue;
        await access(path, constants.X_OK);
        return true;
      } catch {
        /* Try the next PATH entry. */
      }
    }
  }
  return false;
}
export async function diagnoseEnvironment(
  cwd: string,
): Promise<EnvironmentReport> {
  const [rg, pwsh, git] = await Promise.all(
    ["rg", "pwsh", "git"].map(cliAvailable),
  );
  const workspace = { exists: false, readable: false, writable: false };
  try {
    workspace.exists = (await stat(cwd)).isDirectory();
  } catch {
    /* Report below. */
  }
  if (workspace.exists) {
    try {
      await readdir(cwd);
      workspace.readable = true;
    } catch {
      /* Report below. */
    }
    const probe = join(cwd, `.xharness-probe-${randomUUID()}`);
    let created = false;
    try {
      const file = await open(probe, "wx");
      created = true;
      await file.close();
      workspace.writable = true;
    } catch {
      /* Report below. */
    } finally {
      if (created)
        try {
          await rm(probe);
        } catch {
          workspace.writable = false;
        }
    }
  }
  const warnings = [
    ...(!rg
      ? [
          "環境診断：rgが見つかりません。Grep / GlobはNode検索へ自動で切り替えます。",
        ]
      : []),
    ...(!pwsh
      ? [
          "環境診断：PowerShell 7（pwsh）が見つかりません。Bashは実行できません。",
        ]
      : []),
    ...(!git
      ? ["環境診断：gitが見つかりません。Git操作は実行できません。"]
      : []),
    ...(!workspace.exists
      ? [
          "環境診断：作業フォルダが存在しません。対象フォルダを確認してください。",
        ]
      : !workspace.readable
        ? [
            "環境診断：作業フォルダを読み取れません。アクセス権限を確認してください。",
          ]
        : []),
    ...(workspace.exists && !workspace.writable
      ? [
          "環境診断：作業フォルダへ書き込めません。アクセス権限を確認してください。",
        ]
      : []),
  ];
  return {
    cli: { rg: !!rg, pwsh: !!pwsh, git: !!git },
    workspace,
    warnings,
    summary: `環境診断：検索=${rg ? "rg" : "Node代替"}、PowerShell7=${pwsh ? "利用可" : "なし"}、Git=${git ? "利用可" : "なし"}、作業フォルダ=${!workspace.exists ? "なし" : !workspace.readable ? "読取不可" : !workspace.writable ? "書込不可" : "読書可"}。`,
  };
}
