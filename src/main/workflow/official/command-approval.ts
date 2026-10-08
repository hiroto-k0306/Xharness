import { basename, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { analyzeCommand } from "../../core/shell-command.js";
import { redact } from "../../core/redact.js";
import { normalizeFile, type AgentRequest } from "./contracts.js";
import { scopedPath } from "./workspace.js";
import type { Operation } from "./operation-approval.js";

/** Fixed rejection codes. Never derived from request text. */
export type RejectionStage =
  "binding" | "envelope" | "syntax" | "program" | "target" | "identity";
export interface ApprovalRejection {
  stage: RejectionStage;
  reason: string;
}
/** Allowlisted, non-secret description of a native approval request. */
export interface CommandShape {
  /** Known fields whose value is not null/undefined. */
  fields: string[];
  unknownFields: number;
  kind: string | null;
  availableDecisions: string[];
  commandType: string;
  commandLength: number | null;
  tokenCount: number | null;
  program: string | null;
  wrapper: boolean;
  cwd: "same" | "different" | "missing";
  commandActions: string[];
  /** A short identifier only; anything else is reported as "other". */
  environment: string | null;
}
export type CommandDecision =
  | { kind: "test"; shape: CommandShape }
  | { kind: "operation"; operation: Operation; shape: CommandShape }
  | ({ kind: "rejected"; shape: CommandShape } & ApprovalRejection);

const KNOWN_FIELDS = [
  "threadId",
  "turnId",
  "itemId",
  "approvalId",
  "command",
  "cwd",
  "reason",
  "kind",
  "commandActions",
  "additionalPermissions",
  "networkApprovalContext",
  "proposedExecpolicyAmendment",
  "proposedNetworkPolicyAmendments",
  "availableDecisions",
  "environmentId",
  "startedAtMs",
];
const WRAPPERS = /^(?:pwsh|powershell|cmd|bash|sh|zsh|wsl)(?:\.exe)?$/i;

export function commandShape(
  request: AgentRequest,
  params: Record<string, unknown>,
): CommandShape {
  const command = typeof params.command === "string" ? params.command : null;
  const tokens = command === null ? null : analyzeCommand(command).tokens;
  const first = tokens?.[0];
  // Only a bare executable name, never a path, argument or quoted text.
  const program =
    first && /^[A-Za-z0-9._-]{1,64}$/.test(basename(first))
      ? basename(first)
      : null;
  return {
    fields: Object.keys(params)
      .filter((k) => KNOWN_FIELDS.includes(k) && params[k] != null)
      .sort(),
    unknownFields: Object.keys(params).filter((k) => !KNOWN_FIELDS.includes(k))
      .length,
    kind:
      typeof params.kind === "string" && /^[A-Za-z]{1,30}$/.test(params.kind)
        ? params.kind
        : params.kind == null
          ? null
          : "unknown",
    // Decision names only; amendment payloads are never copied.
    availableDecisions: (Array.isArray(params.availableDecisions)
      ? params.availableDecisions
      : []
    )
      .slice(0, 10)
      .map((d) =>
        typeof d === "string"
          ? d
          : d && typeof d === "object"
            ? (Object.keys(d)[0] ?? "unknown")
            : "unknown",
      )
      .map((d) => (/^[A-Za-z]{1,40}$/.test(d) ? d : "unknown")),
    commandType: Array.isArray(params.command)
      ? "array"
      : params.command === null
        ? "null"
        : typeof params.command,
    commandLength: command?.length ?? null,
    tokenCount: tokens?.length ?? null,
    program,
    wrapper: !!program && WRAPPERS.test(program),
    cwd:
      typeof params.cwd !== "string"
        ? "missing"
        : normalizeFile(params.cwd) === normalizeFile(request.cwd)
          ? "same"
          : "different",
    environment:
      params.environmentId == null
        ? null
        : typeof params.environmentId === "string" &&
            /^[A-Za-z0-9_-]{1,64}$/.test(params.environmentId)
          ? params.environmentId
          : "other",
    commandActions: (Array.isArray(params.commandActions)
      ? params.commandActions
      : []
    )
      .slice(0, 20)
      .map((a) => (a as { type?: unknown } | null)?.type)
      .map((t) =>
        typeof t === "string" && /^[A-Za-z]{1,30}$/.test(t) ? t : "unknown",
      ),
  };
}

/** Deliberately small grammar. Native commandActions are display hints, not authority. */
/** Facts about the native thread that the request alone cannot show. */
export interface ApprovalContext {
  /**
   * True only when this dedicated App Server thread was started with
   * environments: [] and its response selected no environment. XHarness never
   * calls environment/add, so no remote exec server can be selected.
   */
  localEnvironmentOnly: boolean;
}
export async function classifyCommand(
  request: AgentRequest,
  params: Record<string, unknown>,
  context: ApprovalContext = { localEnvironmentOnly: false },
): Promise<CommandDecision> {
  const shape = commandShape(request, params);
  const reject = (stage: RejectionStage, reason: string): CommandDecision => ({
    kind: "rejected",
    stage,
    reason,
    shape,
  });
  if (typeof params.command !== "string")
    return reject("envelope", "command-not-string");
  if (params.command.length > 4000)
    return reject("envelope", "command-too-long");
  if (typeof params.cwd !== "string") return reject("envelope", "cwd-missing");
  if (normalizeFile(params.cwd) !== normalizeFile(request.cwd))
    return reject("envelope", "cwd-mismatch");
  if (params.additionalPermissions != null)
    return reject("envelope", "additional-permissions");
  if (params.networkApprovalContext != null)
    return reject("envelope", "network-approval");
  // A proposed execpolicy amendment is only an offer. XHarness never answers
  // with acceptWithExecpolicyAmendment/acceptForSession, so nothing persists.
  if (
    Array.isArray(params.availableDecisions) &&
    !params.availableDecisions.includes("accept")
  )
    return reject("envelope", "accept-unavailable");
  if (params.proposedNetworkPolicyAmendments != null)
    return reject("envelope", "network-policy-amendment");
  if (params.kind != null && params.kind !== "command")
    return reject("envelope", "kind-unsupported");
  // The implicit local environment id is accepted only when no environment
  // could have been selected for this thread; any other value is rejected.
  if (
    params.environmentId != null &&
    !(
      context.localEnvironmentOnly &&
      typeof params.environmentId === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(params.environmentId)
    )
  )
    return reject("envelope", "environment");
  const original = params.command;
  if (request.nativeWork) {
    // Opaque shell text is never classified as safe. The official sandbox is
    // retained and a person approves this exact command once, compounds included.
    if (
      /[\0]|\.\.[\\/]|(?:\.credentials\.json|auth\.json|\.env\b|\.npmrc|\.netrc|id_rsa|id_ed25519)|git\s+(?:reset|clean)\b/i.test(
        original,
      )
    )
      return reject("target", "protected-native-operation");
    if (
      ![params.threadId, params.turnId, params.itemId].every(
        (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v),
      )
    )
      return reject("identity", "ids-invalid");
    return {
      kind: "operation",
      shape,
      operation: {
        requestId: request.requestId,
        sessionId: params.threadId as string,
        turnId: params.turnId as string,
        itemId: params.itemId as string,
        command: original,
        cwd: request.cwd,
        targets: [request.cwd],
        reason:
          typeof params.reason === "string"
            ? redact(params.reason.slice(0, 1000))
            : "公式エージェントが要求した操作。コマンド全体を確認してください。",
      },
    };
  }
  // Codex on Windows wraps the model's command in Windows PowerShell. Only this
  // exact form is unwrapped; the inner text then meets the unwrapped grammar.
  const wrapped = windowsPowerShellCommand(original);
  if (wrapped === "ambiguous") return reject("program", "shell-wrapper");
  const command = wrapped ?? original;
  const analyzed = analyzeCommand(command);
  // The shared tokenizer is a policy hint, not a PowerShell parser. Reject
  // embedded/doubled quotes whose lexical path could differ from its tokens.
  const wholeWords = /^(?:(?:'[^']*'|"[^"]*"|[^\s'"]+)(?:\s+|$))+$/;
  if (!analyzed.simple) return reject("syntax", "not-simple");
  if (analyzed.riskyOption) return reject("syntax", "risky-option");
  if (/[\0*?\[\]]/.test(command)) return reject("syntax", "wildcard-or-nul");
  if (!wholeWords.test(command.trim())) return reject("syntax", "quoting");
  const ids = [params.threadId, params.turnId, params.itemId].every(
    (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(v),
  );
  const operation = (targets: string[], reason: string): CommandDecision =>
    ids
      ? {
          kind: "operation",
          shape,
          operation: {
            requestId: request.requestId,
            sessionId: params.threadId as string,
            turnId: params.turnId as string,
            itemId: params.itemId as string,
            // The grant is bound to the exact native text, wrapper included.
            command: original,
            cwd: request.cwd,
            targets,
            reason:
              typeof params.reason === "string"
                ? redact(params.reason.slice(0, 1000))
                : reason,
          },
        }
      : reject("identity", "ids-invalid");
  const test = request.tests.find((t) => t.command === command);
  if (test)
    // A wrapped registered test is a new form, so it is asked once, not preapproved.
    return wrapped === undefined
      ? { kind: "test", shape }
      : operation(
          test.args.filter((a) => !a.startsWith("-")).slice(0, 20).length
            ? test.args.filter((a) => !a.startsWith("-")).slice(0, 20)
            : [test.id],
          `登録テスト${test.id}の実行（Windows PowerShell -Command経由）`,
        );
  const [name, ...args] = analyzed.tokens;
  if (!/^Get-Content$/i.test(name ?? ""))
    return reject(
      "program",
      shape.wrapper && wrapped === undefined
        ? "shell-wrapper"
        : "program-not-allowed",
    );
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (/^-Raw$/i.test(arg)) continue;
    if (/^-(LiteralPath|Path)$/i.test(arg)) {
      if (!args[i + 1] || args[i + 1]!.startsWith("-"))
        return reject("target", "path-value-missing");
      paths.push(args[++i]!);
    } else if (arg.startsWith("-"))
      return reject("target", "option-unsupported");
    else paths.push(arg);
  }
  if (paths.length !== 1) return reject("target", "path-count");
  const path = paths[0]!;
  if (
    !request.files.some(
      (f) =>
        normalizeFile(resolve(request.cwd, f)) ===
        normalizeFile(resolve(request.cwd, path)),
    )
  )
    return reject("target", "not-planned-file");
  try {
    const target = await scopedPath(request.cwd, path);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.nlink !== 1)
      return reject("target", "not-regular-file");
  } catch {
    return reject("target", "outside-or-unavailable");
  }
  return operation(
    [path],
    wrapped === undefined
      ? "実装対象ファイルの読み取り"
      : "実装対象ファイルの読み取り（Windows PowerShell -Command経由）",
  );
}

const SYSTEM_POWERSHELL = [
  "C:",
  "Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
];
/**
 * Exactly `"<system powershell.exe>" -Command '<inner>'` or
 * `"<system powershell.exe>" -NoProfile -Command '<inner>'`, the forms Codex
 * uses on Windows (the second approved 2026-10-07). Returns the inner text,
 * undefined when the command is not this wrapper at all, or "ambiguous" for any
 * near-miss (other shell, option, order, quote).
 */
export function windowsPowerShellCommand(
  command: string,
): string | undefined | "ambiguous" {
  if (!/^\s*"?[^"\s]*(?:powershell|pwsh)(?:\.exe)?"?(?:\s|$)/i.test(command))
    return undefined;
  // Codex shows the argv with either single or doubled path separators.
  for (const option of [" -Command '", " -NoProfile -Command '"])
    for (const separator of ["\\", "\\\\"]) {
      const prefix = '"' + SYSTEM_POWERSHELL.join(separator) + '"' + option;
      if (
        command.length > prefix.length + 1 &&
        command.slice(0, prefix.length).toLowerCase() ===
          prefix.toLowerCase() &&
        command.slice(prefix.length - option.length, prefix.length) ===
          option &&
        command.endsWith("'")
      ) {
        const inner = command.slice(prefix.length, -1);
        // One single-quoted argument: no further quotes, escapes or expansion.
        return inner.trim() && !/['"`$\r\n\0]/.test(inner)
          ? inner
          : "ambiguous";
      }
    }
  return "ambiguous";
}

export async function commandApproval(
  request: AgentRequest,
  params: Record<string, unknown>,
  context?: ApprovalContext,
): Promise<"test" | Operation | null> {
  const decision = await classifyCommand(request, params, context);
  return decision.kind === "test"
    ? "test"
    : decision.kind === "operation"
      ? decision.operation
      : null;
}
