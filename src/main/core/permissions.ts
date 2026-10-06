import { dirname, relative, resolve, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { type ToolCall } from "../tools/registry.js";
import {
  analyzeCommand,
  bashGrantPattern,
  subcommands,
} from "./shell-command.js";
import { isProtectedPath, isSecretPath } from "./sensitive-paths.js";

export type PermissionMode = "default" | "acceptEdits" | "plan";
export type Decision = "allow" | "deny" | "ask";
export interface Rule {
  tool: string;
  pattern?: string;
  decision: Decision;
}
export interface PermissionConfig {
  mode: PermissionMode;
  rules: Rule[];
}
export const permissionModes = ["default", "acceptEdits", "plan"] as const;
export function rules(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((r: unknown) => {
    if (!r || typeof r !== "object") return [];
    const v = r as Record<string, unknown>;
    return typeof v.tool === "string" &&
      v.tool.length <= 100 &&
      (v.pattern === undefined ||
        (typeof v.pattern === "string" && v.pattern.length <= 2000)) &&
      ["allow", "deny", "ask"].includes(String(v.decision))
      ? [
          {
            tool: v.tool,
            pattern: v.pattern as string | undefined,
            decision: v.decision as Decision,
          },
        ]
      : [];
  });
}
function glob(pattern: string, text: string) {
  if (pattern.endsWith(" *") && text === pattern.slice(0, -2)) return true;
  const escaped = pattern
    .split("*")
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "i").test(text);
}
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "ENOENT" ||
      dirname(path) === path
    )
      throw error;
    return resolve(
      await canonical(dirname(path)),
      relative(dirname(path), path),
    );
  }
}
/** ルールの tool が呼び出しに当たるか。`mcp__<server>` と `mcp__<server>__*` はサーバー全体(§25.5) */
function ruleTool(rule: string, name: string): boolean {
  if (rule === "Edit" && name === "MultiEdit") return true;
  if (rule === "*" || rule === name) return true;
  if (!name.startsWith("mcp__")) return false;
  if (!rule.startsWith("mcp__")) return false;
  const server = rule.slice(5, rule.endsWith("__*") ? -3 : undefined);
  // サーバー名は __ を含まない(.mcp.json の検証と同じ)。`mcp__a__b` はツール1つのルール
  return (
    /^[A-Za-z0-9_-]{1,64}$/.test(server) &&
    !server.includes("__") &&
    name.startsWith(`mcp__${server}__`)
  );
}
export function ruleSubject(call: ToolCall): string {
  const input = call.input as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return "";
  // MCP のリソースはサーバー単位で許可する(§25.5)
  if (call.name === "ReadMcpResource") return String(input.server ?? "");
  if (call.name === "ReadProjectHistory") return String(input.sessionId ?? "");
  return String(input.command ?? input.path ?? input.url ?? input.query ?? "");
}
/** 明らかに破壊的なコマンド。括弧や連結の中にあっても見つける */
export function dangerous(command: string) {
  return /(?:^|[^\w-])(?:rm|rmdir|del|erase|rd|ri|Remove-Item|Clear-Content|Format-Volume|Clear-Disk|Invoke-Expression|iex|Start-Process|saps)(?![\w-])|git\s+(?:reset\s+--hard|clean|push\s+.*--force)|(?:^|\s)(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b.*\|/i.test(
    command,
  );
}

/** plan モード(読み取り専用)で確認なしに動かしてよい、読み取りだけのコマンド */
const READ_ONLY_COMMAND =
  /^(?:Get-(?:Content|ChildItem|Location)(?:\s|$)|rg(?:\s|$)|pwd$)/i;

interface PathCheck {
  target?: string;
  /** 作業フォルダの外(または解決できない) */
  outside: boolean;
  secret: boolean;
  /** 作業フォルダ内の保護パス(.git / .xharness / シェル設定など) */
  protectedPath: boolean;
}

async function checkPath(subject: string, cwd: string): Promise<PathCheck> {
  let target: string | undefined;
  let outside = true;
  let protectedPath = false;
  try {
    const root = await canonical(cwd);
    target = await canonical(resolve(cwd, subject));
    const rel = relative(root, target);
    outside = rel.startsWith("..") || isAbsolute(rel);
    // 保護パスは作業フォルダからの相対で見る(~/.xharness/worktrees の中の作業は対象外)
    protectedPath = !outside && isProtectedPath(rel);
  } catch {
    /* 解決できない対象は外側として扱う */
  }
  return {
    target,
    outside,
    protectedPath,
    secret: isSecretPath(subject) || (!!target && isSecretPath(target)),
  };
}

/**
 * §9 の権限判定。Claude Code と同じく deny → ask → allow の順に評価し、
 * ルールの細かさで順序は変えない。保護パス・秘密ファイル・単純でないコマンドは allow ルールでも確認する。
 */
/**
 * 先頭の「作業フォルダそのものへの cd / Set-Location」を取り除く(何もしない操作のため)。
 * Claude Code と同じく、cwd への移動は判定に影響させない。別のフォルダへの移動はそのまま残す。
 */
export async function withoutCwdPrefix(
  command: string,
  cwd: string,
): Promise<string> {
  const match =
    /^\s*(?:cd|chdir|sl|Set-Location|Push-Location|pushd)\s+(?:-(?:Literal)?Path\s+)?(?:'([^']*)'|"([^"$`]*)"|([^\s;&|'"$`()]+))\s*(?:;|&&)\s*([\s\S]+)$/i.exec(
      command,
    );
  if (!match) return command;
  const target = match[1] ?? match[2] ?? match[3] ?? "";
  try {
    const [root, resolved] = await Promise.all([
      canonical(cwd),
      canonical(resolve(cwd, target)),
    ]);
    const same =
      process.platform === "win32"
        ? root.toLowerCase() === resolved.toLowerCase()
        : root === resolved;
    return same ? withoutCwdPrefix(match[4]!, cwd) : command;
  } catch {
    return command;
  }
}

/**
 * 判定と「常に許可」の保存に使う形にそろえる。
 * - Bash: cwd への cd を除く
 * - McpCall: 実際の名前 `mcp__<server>__<tool>` の呼び出しとして扱う(§25.5)
 */
export async function normalizeCall<T extends ToolCall>(
  call: T,
  cwd: string,
): Promise<T> {
  if (call.name === "McpCall") {
    const input = call.input as Record<string, unknown> | null;
    return input &&
      typeof input.server === "string" &&
      typeof input.tool === "string"
      ? { ...call, name: `mcp__${input.server}__${input.tool}` }
      : call;
  }
  if (call.name !== "Bash") return call;
  const input = call.input as Record<string, unknown> | null;
  if (!input || typeof input.command !== "string") return call;
  const command = await withoutCwdPrefix(input.command, cwd);
  return command === input.command
    ? call
    : { ...call, input: { ...input, command } };
}

export async function decidePermission(
  call: ToolCall,
  config: PermissionConfig,
  cwd: string,
  opts: { readOnly?: boolean; scratch?: boolean; sessionRules?: Rule[] } = {},
): Promise<Decision> {
  call = await normalizeCall(call, cwd);
  const subject = ruleSubject(call);
  const all = [...config.rules, ...(opts.sessionRules ?? [])].filter((r) =>
    ruleTool(r.tool, call.name),
  );
  const matches = (r: Rule, text: string) => {
    if (call.name === "WebFetch" && r.pattern?.startsWith("domain:")) {
      try {
        return (
          new URL(text).hostname.toLowerCase() ===
          r.pattern.slice(7).toLowerCase()
        );
      } catch {
        return false;
      }
    }
    return !r.pattern || glob(r.pattern, text);
  };
  // 制限するルール(deny / ask)は、連結や括弧の中の部分コマンドに一致しても効く
  const parts =
    call.name === "Bash" ? [subject, ...subcommands(subject)] : [subject];
  const restricted = (decision: Decision) =>
    all.some(
      (r) => r.decision === decision && parts.some((p) => matches(r, p)),
    );
  // 許可するルールは、コマンド全体に一致したときだけ効く
  const allowed = all.some(
    (r) => r.decision === "allow" && matches(r, subject),
  );
  if (restricted("deny")) return "deny";
  const mode = opts.readOnly ? "plan" : config.mode;
  // 接続中サーバーの一覧・説明だけを返すツール。承認済みのサーバーからの情報なので確認しない
  if (call.name === "McpSearch" || call.name === "ListMcpResources")
    return restricted("ask") ? "ask" : "allow";
  // リソースの読み取りは plan でも使えるが、初回は確認する(「常に許可」はサーバー単位)
  if (call.name === "ReadMcpResource")
    return restricted("ask") ? "ask" : allowed ? "allow" : "ask";
  if (call.name.startsWith("mcp__") || call.name === "McpCall") {
    // MCP のツールは副作用が分からない。plan では使わず、acceptEdits でも自動では許可しない(§25.5)
    if (mode === "plan") return "deny";
    if (restricted("ask")) return "ask";
    return allowed ? "allow" : "ask";
  }
  const write = [
    "Write",
    "Edit",
    "MultiEdit",
    "ProposeProjectMemory",
    "LocalBrowserClick",
  ].includes(call.name);
  if (mode === "plan" && write) return "deny";
  if (call.name === "Bash") {
    const shape = analyzeCommand(subject);
    const confirm = (): Decision => (mode === "plan" ? "deny" : "ask");
    if (dangerous(subject)) return confirm();
    // 連結・部分式・リダイレクトなど、解析しきれない形はルールでも許可しない
    if (!shape.simple || shape.riskyOption) return confirm();
    if (
      /--work-tree\b|\b(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item|Rename-Item|Set-ItemProperty|New-ItemProperty)\b/i.test(
        subject,
      )
    )
      return confirm();
    // Resolve possible path arguments too: a relative junction can hide an
    // outside/secret target even though its spelling looks harmless.
    const paths = shape.tokens
      .slice(1)
      .flatMap((token) => token.replace(/^-{1,2}[\w-]+[:=]/, "").split(","))
      .filter((token) => token && !token.startsWith("-"));
    const targets = await Promise.all(
      paths.map((path) => checkPath(path, cwd)),
    );
    if (
      shape.tokens.some((t) => isSecretPath(t)) ||
      targets.some((p) => p.secret)
    )
      return "ask";
    if (restricted("ask")) return "ask";
    // Git reads can execute repository-configured fsmonitor, external diff,
    // textconv and pager helpers. A lexical read classification cannot prove
    // their safety; even an allow rule must not bypass confirmation.
    if (
      shape.tokens[0]?.toLowerCase() === "git" &&
      ["status", "diff", "log", "show"].includes(
        shape.tokens[1]?.toLowerCase() ?? "",
      )
    )
      return "ask";
    if (mode === "plan") {
      if (!READ_ONLY_COMMAND.test(subject)) return "deny";
      // 作業フォルダの外を読む引数は、読み取りでも確認する
      return shape.outsidePath || targets.some((p) => p.outside)
        ? "ask"
        : "allow";
    }
    return allowed ? "allow" : "ask";
  }
  if (
    ["Read", "Write", "Edit", "MultiEdit", "Grep", "Glob"].includes(call.name)
  ) {
    const path = await checkPath(subject, cwd);
    if (path.secret) return "ask";
    if (write) {
      // 作業フォルダ外への書き込み・保護パスへの書き込みは、ルールやモードによらず確認
      if (path.outside || path.protectedPath) return "ask";
    } else if (path.outside) {
      // 作業フォルダ外の読み取りは、それを許可するルールがあるときだけ確認なし
      if (restricted("ask")) return "ask";
      return allowed ? "allow" : "ask";
    }
  }
  if (restricted("ask")) return "ask";
  if (allowed) return "allow";
  if (write && (mode === "acceptEdits" || opts.scratch)) return "allow";
  return ["Read", "Grep", "Glob"].includes(call.name) ? "allow" : "ask";
}

/**
 * 「常に許可」で保存するルール。Bash はサブコマンドまで含めて狭く保存する
 * (例: `git status` → `git status *`。`git *` にはしない)。
 */
export function grantFor(call: ToolCall): Rule {
  const subject = ruleSubject(call);
  if (call.name === "Bash")
    return {
      tool: "Bash",
      pattern: bashGrantPattern(subject),
      decision: "allow",
    };
  if (call.name === "WebFetch") {
    // Claude Code と同じくドメイン単位で許可する
    try {
      const url = new URL(subject);
      return {
        tool: "WebFetch",
        pattern: `domain:${url.hostname.toLowerCase()}`,
        decision: "allow",
      };
    } catch {
      return { tool: "WebFetch", pattern: subject, decision: "allow" };
    }
  }
  if (call.name === "ReadMcpResource")
    return { tool: "ReadMcpResource", pattern: subject, decision: "allow" };
  return { tool: call.name, decision: "allow" };
}
