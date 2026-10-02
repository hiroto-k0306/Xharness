// MCP サーバーの承認(DESIGN.md §25.3)。リポジトリの外(~/.xharness/projects/<鍵>/)に、
// 展開前の定義のハッシュで保存する。定義が変わったら未承認に戻る。
import { join } from "node:path";
import { workspaceKey } from "../config/trust.js";
import { JsonFile } from "../session/store.js";

export type McpApproval = "approved" | "rejected";
type Stored = Record<string, { hash: string; decision: McpApproval }>;

export class McpApprovals {
  private constructor(private readonly file: JsonFile<Stored>) {}
  static async open(home: string, root: string): Promise<McpApprovals> {
    return new McpApprovals(
      new JsonFile(
        join(home, "projects", await workspaceKey(root), "mcp-approvals.json"),
        (value): value is Stored =>
          !!value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          Object.values(value).every(
            (v) =>
              !!v &&
              typeof v === "object" &&
              typeof (v as { hash?: unknown }).hash === "string" &&
              ["approved", "rejected"].includes(
                String((v as { decision?: unknown }).decision),
              ),
          ),
      ),
    );
  }
  /** 保存済みの判断。定義が変わっていれば undefined(もう一度尋ねる) */
  async get(name: string, hash: string): Promise<McpApproval | undefined> {
    const entry = (await this.file.read({}))[name];
    return entry?.hash === hash ? entry.decision : undefined;
  }
  async set(name: string, hash: string, decision: McpApproval): Promise<void> {
    const all = await this.file.read({});
    await this.file.write({ ...all, [name]: { hash, decision } });
  }
  /** 承認・拒否の取り消し(/mcp から) */
  async reset(name?: string): Promise<void> {
    if (!name) return this.file.write({});
    const all = await this.file.read({});
    delete all[name];
    await this.file.write(all);
  }
}
