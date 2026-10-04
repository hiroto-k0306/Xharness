import { isAbsolute, join } from "node:path";

/** 開発版 --fake の明示的な保存先だけ、Electron のプロファイルも隔離する。 */
export function fakeUserDataPath(
  fake: boolean,
  packaged: boolean,
  home: string | undefined,
): string | undefined {
  if (!fake || packaged || !home) return undefined;
  if (!isAbsolute(home))
    throw new Error(
      "開発版 --fake の XHARNESS_HOME は絶対パスで指定してください",
    );
  return join(home, "electron-user-data");
}
