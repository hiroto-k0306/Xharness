import { dirname, relative, resolve, isAbsolute } from "node:path";
import { realpath } from "node:fs/promises";
import { type ToolCall } from "../tools/registry.js";

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
export function ruleSubject(call: ToolCall): string {
  const input = call.input as Record<string, unknown> | null;
  if (!input || typeof input !== "object") return "";
  return String(input.command ?? input.path ?? input.url ?? input.query ?? "");
}
export function dangerous(command: string) {
  return /(?:^|[;|&\s])(?:rm|rmdir|del|Remove-Item|Format-Volume|Clear-Disk|Invoke-Expression|iex)\b|git\s+(?:reset\s+--hard|clean|push\s+.*--force)|(?:^|\s)(?:curl|wget)\b.*\|/i.test(
    command,
  );
}
export async function decidePermission(
  call: ToolCall,
  config: PermissionConfig,
  cwd: string,
  opts: { readOnly?: boolean; scratch?: boolean; sessionRules?: Rule[] } = {},
): Promise<Decision> {
  const subject = ruleSubject(call);
  const matching = [...config.rules, ...(opts.sessionRules ?? [])].filter(
    (r) =>
      (r.tool === "*" || r.tool === call.name) &&
      (!r.pattern || glob(r.pattern, subject)),
  );
  if (matching.some((r) => r.decision === "deny")) return "deny";
  const mode = opts.readOnly ? "plan" : config.mode;
  const write = ["Write", "Edit"].includes(call.name);
  if (mode === "plan" && write) return "deny";
  if (call.name === "Bash") {
    if (dangerous(subject)) return mode === "plan" ? "deny" : "ask";
    if (
      /[;|&>\r\n$`]/.test(subject) ||
      /--work-tree\b|\b(?:Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|New-Item)\b/i.test(
        subject,
      )
    )
      return mode === "plan" ? "deny" : "ask";
    if (
      mode === "plan" &&
      !/^(?:git (?:status|diff|log|show)(?:\s|$)|Get-(?:Content|ChildItem|Location)(?:\s|$)|rg(?:\s|$)|pwd$)/i.test(
        subject,
      )
    )
      return "deny";
    if (mode === "plan" && /[;|&>\r\n]/.test(subject)) return "deny";
    if (
      mode === "plan" &&
      /\$|`|--(?:ext-diff|textconv|output|exec)\b|\s-(?:c|C)\s/.test(subject)
    )
      return "deny";
    if (
      /(?:^|[\s/\\:'"])(?:\.env(?:\b|\.)|auth\.json\b|\.credentials\.json\b|id_rsa\b|id_ed25519\b)/i.test(
        subject,
      )
    )
      return "ask";
  }
  if (["Read", "Write", "Edit", "Grep"].includes(call.name)) {
    let resolvedSubject = subject;
    try {
      resolvedSubject = await canonical(resolve(cwd, subject));
    } catch {
      /* Literal check remains applicable. */
    }
    if (
      /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|auth\.json|\.credentials\.json|id_rsa|id_ed25519)$/i.test(
        subject,
      ) ||
      /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|auth\.json|\.credentials\.json|id_rsa|id_ed25519)$/i.test(
        resolvedSubject,
      )
    )
      return "ask";
    if (write) {
      try {
        const root = await canonical(cwd);
        const target = await canonical(resolve(cwd, subject));
        const rel = relative(root, target);
        if (rel.startsWith("..") || isAbsolute(rel)) return "ask";
      } catch {
        return "ask";
      }
    }
  }
  if (matching.some((r) => r.decision === "ask")) return "ask";
  if (matching.some((r) => r.decision === "allow")) return "allow";
  if (mode === "plan" && call.name === "Bash") return "allow";
  if (write && (mode === "acceptEdits" || opts.scratch)) return "allow";
  return ["Read", "Grep", "Glob"].includes(call.name) ? "allow" : "ask";
}

/** A persisted Bash grant covers the first command token; dangerous commands still ask. */
export function grantFor(call: ToolCall): Rule {
  const first = ruleSubject(call).trim().split(/\s+/)[0] ?? "";
  return {
    tool: call.name,
    ...(call.name === "Bash" ? { pattern: `${first} *` } : {}),
    decision: "allow",
  };
}
