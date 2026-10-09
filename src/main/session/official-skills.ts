import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { parseDocument } from "yaml";
import { isSecretPath } from "../core/sensitive-paths.js";
import { historyText } from "../tools/project-history.js";
import type {
  OfficialSkillBundle,
  OfficialSkillCatalog,
  OfficialSkillEntry,
  OfficialSkillPreview,
  OfficialSkillSelection,
} from "../../shared/official-skills.js";

export const OFFICIAL_SKILL_LIMITS = {
  entries: 50,
  directoryEntries: 100,
  files: 20,
  fileBytes: 65536,
  totalBytes: 16384,
  depth: 8,
  frontmatterBytes: 4096,
} as const;
const same = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const signature = (s: Stats) =>
  [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink].join(":");
function fault(reason: string): never {
  throw new Error(reason);
}
const ordinary = (text: string) => {
  const normalized = text.replace(/\r\n/g, "\n");
  return historyText(normalized, (s) => s) === normalized;
};
type Provider = OfficialSkillSelection["provider"];
type Scope = OfficialSkillSelection["scope"];

/** Fixed provider roots. The private home seam is for fixtures, never an IPC path. */
export class OfficialSkills {
  private readonly userHome: string;
  private readonly directoryIdentities = new Map<string, string>();
  constructor(
    private readonly options: {
      cwd: string;
      provider: Provider;
      baseUserHome?: string;
    },
  ) {
    this.userHome = resolve(options.baseUserHome ?? homedir());
  }
  private root(scope: Scope) {
    return join(
      scope === "user" ? this.userHome : resolve(this.options.cwd),
      this.options.provider === "claude" ? ".claude" : ".agents",
      "skills",
    );
  }
  private pinDirectory(path: string, info: Stats) {
    const key = process.platform === "win32" ? path.toLowerCase() : path;
    const identity = `${info.dev}:${info.ino}`;
    const previous = this.directoryIdentities.get(key);
    if (previous !== undefined && previous !== identity)
      fault(
        "スキルの作業ルートまたは祖先ディレクトリが読取中に変更されました。",
      );
    this.directoryIdentities.set(key, identity);
  }
  private async checked(scope: Scope, path: string, file = false) {
    const base = scope === "user" ? this.userHome : resolve(this.options.cwd);
    const root = this.root(scope);
    if (!same(await realpath(base), base))
      fault("スキルの作業ルートがリンクまたは変更されたため読取できません。");
    const baseInfo = await lstat(base);
    if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink())
      fault("スキルの作業ルートがリンクまたは不正です。");
    this.pinDirectory(base, baseInfo);
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel) || isSecretPath(path))
      fault("スキルの範囲外・秘密pathは読取できません。");
    let current = base;
    const segments = relative(base, path).split(/[\\/]/).filter(Boolean);
    for (const [i, segment] of segments.entries()) {
      current = join(current, segment);
      const info = await lstat(current);
      if (
        info.isSymbolicLink() ||
        !same(await realpath(current), current) ||
        isSecretPath(current) ||
        (i === segments.length - 1 && file
          ? !info.isFile() || info.nlink !== 1
          : !info.isDirectory())
      )
        fault("スキルのリンク・hard link・不正pathは読取できません。");
      if (info.isDirectory()) this.pinDirectory(current, info);
    }
  }
  private async text(scope: Scope, path: string) {
    await this.checked(scope, path, true);
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > OFFICIAL_SKILL_LIMITS.fileBytes
      )
        fault("スキルファイルの64KiB上限または安全性を確認できません。");
      const bytes = Buffer.alloc(OFFICIAL_SKILL_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      const after = await handle.stat();
      const live = await lstat(path);
      if (
        length !== before.size ||
        length > OFFICIAL_SKILL_LIMITS.fileBytes ||
        signature(before) !== signature(after) ||
        signature(after) !== signature(live)
      )
        fault("スキルファイルが読取中に変更されました。");
      await this.checked(scope, path, true);
      let text: string;
      try {
        text = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes.subarray(0, length));
      } catch {
        return fault("スキルの非UTF-8ファイルには対応していません。");
      }
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))
        fault("スキルのバイナリ・制御文字には対応していません。");
      if (!ordinary(text))
        fault(
          "スキルに資格情報らしい内容があります。本文は表示・送信しません。",
        );
      return { text, signature: signature(live), bytes: length };
    } finally {
      await handle.close();
    }
  }
  private metadata(text: string) {
    const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
      text,
    );
    if (
      !match ||
      Buffer.byteLength(match[0]) > OFFICIAL_SKILL_LIMITS.frontmatterBytes
    )
      fault("スキルのfrontmatterが欠落または上限超過です。");
    let data: Record<string, unknown>;
    try {
      const doc = parseDocument(match![1]!, { uniqueKeys: true });
      if (doc.errors.length || doc.warnings.length) throw new Error();
      const value: unknown = doc.toJS({ maxAliasCount: 0 });
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error();
      data = value as Record<string, unknown>;
    } catch {
      return fault("スキルのfrontmatterが不正です。");
    }
    if (
      typeof data.name !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(data.name) ||
      typeof data.description !== "string" ||
      !data.description.trim() ||
      data.description.length > 1024
    )
      fault("スキルのname/descriptionが不正です。");
    const unsupported = Object.keys(data).filter(
      (key) => !["name", "description", "user-invocable"].includes(key),
    );
    if (unsupported.length)
      fault(
        "未対応のスキル設定があります。権限・モデル・フックを有効にしていません。",
      );
    if (
      Object.hasOwn(data, "user-invocable") &&
      data["user-invocable"] !== true
    )
      fault("user-invocableがtrueでないスキルの明示利用には対応していません。");
    return {
      name: data.name as string,
      description: data.description as string,
    };
  }
  private scope(source: string): Scope {
    if (!isAbsolute(source) || !same(resolve(source), source))
      fault("スキルの出典pathが不正です。");
    for (const scope of ["user", "project"] as const) {
      const rel = relative(this.root(scope), source).split(/[\\/]/);
      if (
        rel.length === 2 &&
        /^[A-Za-z0-9_-]{1,64}$/.test(rel[0]!) &&
        rel[1] === "SKILL.md"
      )
        return scope;
    }
    return fault("登録されたproviderのスキルルート外です。");
  }
  async preview(source: string): Promise<OfficialSkillPreview> {
    const scope = this.scope(source);
    const entry: OfficialSkillEntry = {
      provider: this.options.provider,
      scope,
      source,
      name: dirname(source).split(/[\\/]/).at(-1)!,
      description: "",
      hash: "",
      bundleHash: "",
      eligible: false,
      reasons: [],
    };
    try {
      const skill = await this.text(scope, source);
      Object.assign(entry, this.metadata(skill.text), {
        hash: hash(skill.text),
      });
      const directory = dirname(source);
      const files: OfficialSkillBundle["files"] = [];
      const signatures = new Map<string, string>();
      const directories = new Map<string, string>();
      let total = 0,
        count = 0;
      const walk = async (path: string, depth: number) => {
        if (depth > OFFICIAL_SKILL_LIMITS.depth)
          fault("スキルの関連資料が深さ上限を超えています。");
        await this.checked(scope, path);
        directories.set(path, signature(await lstat(path)));
        const reader = await opendir(path);
        for await (const item of reader) {
          if (++count > OFFICIAL_SKILL_LIMITS.directoryEntries)
            fault("スキルの関連資料が列挙上限を超えています。");
          const target = join(path, item.name);
          const info = await lstat(target);
          if (
            info.isSymbolicLink() ||
            isSecretPath(target) ||
            item.name.startsWith(".") ||
            /(?:^|[._-])(?:tmp|temp|bak|backup)(?:[._-]|$)|~$|^#.*#$|^node_modules$/i.test(
              item.name,
            ) ||
            !/^[^\x00-\x1f\\/]+$/.test(item.name)
          )
            fault(
              "スキルの関連資料にリンク・秘密path・非対応の一時/隠しファイルがあります。",
            );
          if (info.isDirectory()) {
            await walk(target, depth + 1);
            continue;
          }
          if (
            !info.isFile() ||
            info.nlink !== 1 ||
            !/\.(?:md|txt|rst)$/i.test(item.name)
          )
            fault(
              "スキルのscript・バイナリ等には対応していません。関連資料はmd/txt/rstのみです。",
            );
          if (files.length >= OFFICIAL_SKILL_LIMITS.files)
            fault("スキルの関連資料が20ファイル上限を超えています。");
          const read = await this.text(scope, target);
          if (/!\s*`[^`]+`|(?:```|~~~)!/.test(read.text))
            fault("スキルの動的command展開には対応していません。");
          total += read.bytes;
          if (total > OFFICIAL_SKILL_LIMITS.totalBytes)
            fault(
              "スキル本文と関連資料が合計16KiB上限を超えています。省略せず停止します。",
            );
          signatures.set(target, read.signature);
          files.push({
            relativePath: relative(directory, target).split(/[\\/]/).join("/"),
            body: read.text,
            hash: hash(read.text),
          });
        }
      };
      await walk(directory, 0);
      for (const [path, saved] of [...directories, ...signatures]) {
        await this.checked(scope, path, signatures.has(path));
        if (signature(await lstat(path)) !== saved)
          fault("スキルのbundleが読取中に変更されました。");
      }
      const main = files.find((f) => f.relativePath === "SKILL.md");
      if (main?.hash !== entry.hash)
        fault("スキル本文が読取中に変更されました。");
      files.sort((a, b) =>
        a.relativePath < b.relativePath
          ? -1
          : a.relativePath > b.relativePath
            ? 1
            : 0,
      );
      entry.bundleHash = hash(
        JSON.stringify(
          files.map(({ relativePath, hash }) => ({ relativePath, hash })),
        ),
      );
      entry.eligible = true;
      return { entry, files };
    } catch (error) {
      entry.reasons.push(
        error instanceof Error ? error.message : "スキルを確認できません。",
      );
      return { entry };
    }
  }
  async list(): Promise<OfficialSkillCatalog> {
    const entries: OfficialSkillEntry[] = [];
    const sources = new Set<string>();
    let count = 0;
    for (const scope of ["user", "project"] as const) {
      const root = this.root(scope);
      try {
        await this.checked(scope, root);
        const reader = await opendir(root);
        for await (const item of reader) {
          if (
            ++count > OFFICIAL_SKILL_LIMITS.directoryEntries ||
            entries.length >= OFFICIAL_SKILL_LIMITS.entries
          )
            fault("スキル一覧が上限を超えています。自動で省略・選択しません。");
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(item.name)) continue;
          const source = join(root, item.name, "SKILL.md");
          if (!sources.has(source))
            entries.push((await this.preview(source)).entry);
          sources.add(source);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { entries, limits: OFFICIAL_SKILL_LIMITS };
  }
  async select(
    selection: OfficialSkillSelection,
  ): Promise<OfficialSkillBundle> {
    if (
      selection.provider !== this.options.provider ||
      selection.scope !== this.scope(selection.source)
    )
      fault("選択したスキルのprovider/scopeが一致しません。");
    const preview = await this.preview(selection.source);
    if (!preview.entry.eligible || !preview.files)
      fault(preview.entry.reasons.join("\n") || "スキルは対応外です。");
    if (
      ["name", "hash", "bundleHash"].some(
        (key) =>
          preview.entry[key as "name" | "hash" | "bundleHash"] !==
          selection[key as "name" | "hash" | "bundleHash"],
      )
    )
      fault(
        "選択したスキルの本文・関連資料の版が変わりました。一覧とプレビューを再確認してください。",
      );
    return {
      provider: selection.provider,
      scope: selection.scope,
      name: selection.name,
      source: selection.source,
      hash: selection.hash,
      bundleHash: selection.bundleHash,
      files: preview.files,
    };
  }
}
