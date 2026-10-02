import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isSecretPath } from "../core/sensitive-paths.js";
import { parse, stringify } from "yaml";
import {
  permissionModes,
  rules,
  type PermissionConfig,
  type PermissionMode,
  type Rule,
} from "../core/permissions.js";
import { localRulesPath } from "./trust.js";
import { randomUUID } from "node:crypto";
import { FileAccess } from "../tools/files.js";
export interface ProjectConfig {
  permissions: PermissionConfig;
  context: { compactThreshold: number; memoryFiles: string[] };
  /**
   * 信頼していないワークスペースの設定にあり、適用を保留した「権限を広げる」項目。
   * 信頼の確認(ProjectSettings)で、この内容をユーザーに見せる。
   */
  untrusted?: { rules: Rule[]; mode?: PermissionMode };
}
async function document(path: string): Promise<Record<string, unknown>> {
  try {
    const doc: unknown = parse(await readFile(path, "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Configuration could not be read");
  }
}
/**
 * 設定を読む。順番: ユーザー(~/.xharness/config.yaml)→ プロジェクト(<root>/.xharness/config.yaml)
 * → ユーザーがこのワークスペースで「常に許可」したルール(~/.xharness/projects/<鍵>/permissions.yaml)。
 *
 * プロジェクトの設定はリポジトリから来るので、Claude Code と同じく、allow ルールと
 * 権限を広げるモード(acceptEdits)は `trusted` のときだけ適用する。deny / ask と
 * 権限を狭めるモード(plan / default)は常に適用する。
 */
export async function loadProjectConfig(
  home: string,
  cwd?: string,
  opts: { trusted?: boolean } = {},
): Promise<ProjectConfig> {
  const user = await document(join(home, "config.yaml"));
  const project = cwd
    ? await document(join(cwd, ".xharness", "config.yaml"))
    : {};
  const local = cwd ? await document(await localRulesPath(home, cwd)) : {};
  const result: ProjectConfig = {
    permissions: { mode: "default", rules: [] },
    context: { compactThreshold: 0.8, memoryFiles: ["AGENTS.md", "CLAUDE.md"] },
  };
  const held: { rules: Rule[]; mode?: PermissionMode } = { rules: [] };
  const permissionsOf = (doc: Record<string, unknown>) =>
    doc.permissions && typeof doc.permissions === "object"
      ? (doc.permissions as Record<string, unknown>)
      : undefined;
  const projectPermissions = permissionsOf(project);
  if (projectPermissions && !opts.trusted) {
    // 信頼前は、権限を広げる項目を取り除いて保留する
    const all = rules(projectPermissions.rules);
    held.rules = all.filter((r) => r.decision === "allow");
    if (projectPermissions.mode === "acceptEdits") held.mode = "acceptEdits";
    project.permissions = {
      ...projectPermissions,
      rules: all.filter((r) => r.decision !== "allow"),
      ...(held.mode ? { mode: undefined } : {}),
    };
  }
  if (held.rules.length || held.mode) result.untrusted = held;
  const documents = [user, project, local];
  for (const doc of documents) {
    if (doc.permissions && typeof doc.permissions === "object") {
      const p = doc.permissions as Record<string, unknown>;
      if (permissionModes.includes(p.mode as PermissionConfig["mode"]))
        result.permissions.mode = p.mode as PermissionConfig["mode"];
      result.permissions.rules.push(...rules(p.rules));
    }
    if (doc.context && typeof doc.context === "object") {
      const c = doc.context as Record<string, unknown>;
      if (
        typeof c.compactThreshold === "number" &&
        c.compactThreshold > 0 &&
        c.compactThreshold < 1
      )
        result.context.compactThreshold = c.compactThreshold;
      if (
        Array.isArray(c.memoryFiles) &&
        c.memoryFiles.every((f) => typeof f === "string" && f.length <= 512)
      )
        result.context.memoryFiles = c.memoryFiles;
    }
  }
  return result;
}
const chains = new Map<string, Promise<void>>();
/**
 * 「常に許可」のルールを保存する。ワークスペースがあれば、そのワークスペースだけに効く
 * ユーザー側のファイル(リポジトリの外)へ、無ければ ~/.xharness/config.yaml へ(Claude Code の
 * settings.local.json に相当。リポジトリを汚さず、リポジトリの内容からは書き換えられない)。
 */
export async function saveRule(
  home: string,
  rule: Rule,
  root?: string,
): Promise<void> {
  const path = root
    ? await localRulesPath(home, root)
    : join(home, "config.yaml");
  const job = (chains.get(path) ?? Promise.resolve()).then(async () => {
    const doc = await document(path);
    const permissions =
      doc.permissions && typeof doc.permissions === "object"
        ? (doc.permissions as Record<string, unknown>)
        : {};
    doc.permissions = {
      ...permissions,
      rules: [...rules(permissions.rules), rule],
    };
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, stringify(doc), "utf8");
    await rename(temp, path);
  });
  chains.set(
    path,
    job.catch(() => undefined),
  );
  return job;
}
/** base の中に収まるか(シンボリックリンク・ジャンクションを解決した実体で判定する) */
async function inside(base: string, path: string): Promise<boolean> {
  const access = new FileAccess(base);
  const root = await access.path(".");
  const target = await access.path(path);
  const rel = relative(root, target);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * メモリファイル(§12 context.memoryFiles)を読み、システムプロンプトへ足す本文を返す。
 * 内容はモデルへ送られるので、ホーム(~/.xharness)と作業フォルダの中にあるファイルだけを読む。
 * 絶対パス・`..` で外へ出る指定・秘密ファイルは読まない。
 */
export async function projectMemory(
  home: string,
  cwd: string | undefined,
  files: string[],
): Promise<string> {
  // 従来どおり、ホーム側をすべて先に、作業フォルダ側を後に並べる
  const candidates = [
    ...files.map((file) => ({ base: home, file })),
    ...(cwd ? files.map((file) => ({ base: cwd, file })) : []),
  ];
  const seen = new Set<string>();
  const contents: string[] = [];
  for (const { base, file } of candidates) {
    const path = join(base, file);
    if (seen.has(path)) continue;
    seen.add(path);
    if (isAbsolute(file) || /^[A-Za-z]:/.test(file)) continue;
    try {
      if (!(await inside(base, path))) continue;
      const checked = await new FileAccess(base).path(path);
      if (isSecretPath(path) || isSecretPath(checked)) continue;
      contents.push(
        `${path}:\n${(await readFile(checked, "utf8")).slice(0, 64000)}`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Project memory could not be read");
    }
  }
  return contents.join("\n\n");
}
