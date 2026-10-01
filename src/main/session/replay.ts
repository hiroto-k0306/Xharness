import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { buildReceiptReplay, type ReceiptReplay } from "../../shared/replay.js";
import {
  decidePermission,
  type PermissionConfig,
  type Decision,
} from "../core/permissions.js";

export async function readReceiptReplay(
  home: string,
  sessionId: string,
  options: { parentId?: string; clean?: (text: string) => string } = {},
): Promise<ReceiptReplay> {
  for (const id of [sessionId, options.parentId].filter((v) => v !== undefined))
    if (!/^[\w-]{1,512}$/.test(id!))
      throw new Error("Invalid replay session id");
  const base = options.parentId ? join(home, "agents", options.parentId) : home;
  const path = join(base, "receipts", `${sessionId}.jsonl`);
  let data: string;
  try {
    if ((await stat(path)).size > 16_000_000)
      throw new Error("Replay file exceeds size limit");
    data = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return buildReceiptReplay([]);
    throw new Error("Replay file could not be read");
  }
  if (data.length > 16_000_000)
    throw new Error("Replay file exceeds size limit");
  const replay = buildReceiptReplay(
    data
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      }),
    options.clean,
  );
  replay.frames = replay.frames.filter((frame) => {
    if (frame.receipt.sessionId === sessionId) return true;
    replay.skipped++;
    return false;
  });
  return replay;
}

export interface PermissionComparison {
  position: number;
  receiptId: string;
  agentId?: string;
  recorded?: string;
  current: Decision;
  matches: boolean | null;
}
/** Re-evaluate only gate decisions. Never execute a recorded tool or shell hook. */
export async function compareReplayPermissions(
  replay: ReceiptReplay,
  config: PermissionConfig,
  cwd: string,
  signal: AbortSignal,
): Promise<PermissionComparison[]> {
  const comparisons: PermissionComparison[] = [];
  for (const frame of replay.frames) {
    signal.throwIfAborted();
    const r = frame.receipt;
    if (r.kind !== "tool" || !r.tool || r.input === undefined) continue;
    const current = await decidePermission(
      { id: r.id, name: r.tool, input: r.input },
      config,
      cwd,
    );
    signal.throwIfAborted();
    const recorded = r.decision?.endsWith("allow")
      ? "allow"
      : r.decision?.endsWith("deny")
        ? "deny"
        : undefined;
    comparisons.push({
      position: frame.position,
      receiptId: r.id,
      agentId: r.agentId,
      recorded: r.decision,
      current,
      matches: recorded === undefined ? null : current === recorded,
    });
  }
  return comparisons;
}
