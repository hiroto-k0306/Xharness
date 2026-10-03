import { access, stat, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join, delimiter, isAbsolute } from "node:path";

export interface EnvironmentReport {
  cli: Record<"rg" | "pwsh" | "git", boolean>;
  workspace: { exists: boolean; readable: boolean; writable: boolean };
  warnings: string[];
  summary: string;
}
/** Never runs a shell or prints PATH/credentials. Windows aliases may reject stat. */
export async function resolveCli(
  name: string,
  env = process.env,
): Promise<string | undefined> {
  const extensions = process.platform === "win32" ? [".exe", ""] : [""];
  const directories = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "win32" && name === "pwsh") {
    if (env.LOCALAPPDATA)
      directories.push(join(env.LOCALAPPDATA, "Microsoft", "WindowsApps"));
    if (env.ProgramFiles)
      directories.push(join(env.ProgramFiles, "PowerShell", "7"));
  }
  for (const directory of directories) {
    if (!isAbsolute(directory.replace(/^"|"$/g, ""))) continue;
    for (const extension of extensions) {
      const path = join(directory.replace(/^"|"$/g, ""), name + extension);
      try {
        await access(path, constants.X_OK);
        try {
          if (!(await stat(path)).isFile()) continue;
        } catch (error) {
          // Store execution aliases are accessible but stat can return EACCES.
          if (
            process.platform !== "win32" ||
            extension !== ".exe" ||
            !/[\\/]Microsoft[\\/]WindowsApps$/i.test(directory) ||
            (error as NodeJS.ErrnoException).code !== "EACCES"
          )
            continue;
        }
        return path;
      } catch {
        /* Try the next PATH entry. */
      }
    }
  }
  return undefined;
}
export async function cliAvailable(name: string): Promise<boolean> {
  return !!(await resolveCli(name));
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
    try {
      // Non-mutating permission hint. Actual writes still handle ACL/volume errors.
      await access(cwd, constants.W_OK);
      workspace.writable = true;
    } catch {
      /* Report below. */
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
