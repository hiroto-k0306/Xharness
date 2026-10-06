import { resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { analyzeCommand } from "../../core/shell-command.js";
import { redact } from "../../core/redact.js";
import { normalizeFile, type AgentRequest } from "./contracts.js";
import { scopedPath } from "./workspace.js";
import type { Operation } from "./operation-approval.js";

/** Deliberately small grammar. Native commandActions are display hints, not authority. */
export async function commandApproval(
  request: AgentRequest,
  params: Record<string, unknown>,
): Promise<"test" | Operation | null> {
  if (
    typeof params.command !== "string" ||
    params.command.length > 4000 ||
    typeof params.cwd !== "string" ||
    normalizeFile(params.cwd) !== normalizeFile(request.cwd) ||
    params.additionalPermissions != null ||
    params.networkApprovalContext != null ||
    params.proposedExecpolicyAmendment != null ||
    params.proposedNetworkPolicyAmendments != null ||
    (params.kind != null && params.kind !== "command") ||
    params.environmentId != null
  )
    return null;
  const shape = analyzeCommand(params.command);
  // The shared tokenizer is a policy hint, not a PowerShell parser. Reject
  // embedded/doubled quotes whose lexical path could differ from its tokens.
  const wholeWords = /^(?:(?:'[^']*'|"[^"]*"|[^\s'"]+)(?:\s+|$))+$/;
  if (
    !shape.simple ||
    shape.riskyOption ||
    /[\0*?\[\]]/.test(params.command) ||
    !wholeWords.test(params.command.trim())
  )
    return null;
  if (request.tests.some((t) => t.command === params.command)) return "test";
  const [name, ...args] = shape.tokens;
  if (!/^Get-Content$/i.test(name ?? "")) return null;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^-Raw$/i.test(arg)) continue;
    if (/^-(LiteralPath|Path)$/i.test(arg)) {
      if (!args[i + 1] || args[i + 1]!.startsWith("-")) return null;
      paths.push(args[++i]!);
    } else if (arg.startsWith("-")) return null;
    else paths.push(arg);
  }
  if (paths.length !== 1) return null;
  const path = paths[0]!;
  if (
    !request.files.some(
      (f) =>
        normalizeFile(resolve(request.cwd, f)) ===
        normalizeFile(resolve(request.cwd, path)),
    )
  )
    return null;
  try {
    const target = await scopedPath(request.cwd, path);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.nlink !== 1) return null;
  } catch {
    return null;
  }
  if (
    ![params.threadId, params.turnId, params.itemId].every(
      (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v),
    )
  )
    return null;
  return {
    requestId: request.requestId,
    sessionId: params.threadId as string,
    turnId: params.turnId as string,
    itemId: params.itemId as string,
    command: params.command,
    cwd: request.cwd,
    targets: [path],
    reason:
      typeof params.reason === "string"
        ? redact(params.reason.slice(0, 1000))
        : "実装対象ファイルの読み取り",
  };
}
