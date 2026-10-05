import { isAbsolute, join } from "node:path";

/** --fake の明示的な保存先ごとに、Electron のプロファイルも隔離する。 */
export function fakeUserDataPath(
  fake: boolean,
  _packaged: boolean,
  home: string | undefined,
): string | undefined {
  if (!fake || !home) return undefined;
  if (!isAbsolute(home))
    throw new Error("--fake の XHARNESS_HOME は絶対パスで指定してください");
  return join(home, "electron-user-data");
}
