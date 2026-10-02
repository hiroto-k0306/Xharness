// ワークスペースの信頼(Claude Code の workspace trust に準拠)。
// プロジェクトの .xharness/config.yaml が権限を広げる項目(allow ルール・acceptEdits)は、
// ユーザーがそのワークスペースを信頼してから有効にする。deny / ask は信頼に関係なく常に効く。
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonFile } from "../session/store.js";

/** 信頼・ローカルルールの鍵。同じフォルダは別名(シンボリックリンク・大文字小文字)でも同じ鍵 */
export async function workspaceKey(root: string): Promise<string> {
  let path = resolve(root);
  try {
    path = await realpath(path);
  } catch {
    /* 存在しないフォルダは文字列のまま */
  }
  if (process.platform === "win32") path = path.toLowerCase();
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** 「常に許可」で保存するルールの置き場所(リポジトリの外、ユーザーのホーム側) */
export async function localRulesPath(
  home: string,
  root: string,
): Promise<string> {
  return join(home, "projects", await workspaceKey(root), "permissions.yaml");
}

export class WorkspaceTrust {
  private readonly file: JsonFile<string[]>;
  private trusted?: Set<string>;
  constructor(home: string) {
    this.file = new JsonFile(
      join(home, "trusted-workspaces.json"),
      (value): value is string[] =>
        Array.isArray(value) && value.every((v) => typeof v === "string"),
    );
  }
  private async keys(): Promise<Set<string>> {
    this.trusted ??= new Set(await this.file.read([]));
    return this.trusted;
  }
  async isTrusted(root: string): Promise<boolean> {
    return (await this.keys()).has(await workspaceKey(root));
  }
  async trust(root: string): Promise<void> {
    const keys = await this.keys();
    keys.add(await workspaceKey(root));
    await this.file.write([...keys]);
  }
}
