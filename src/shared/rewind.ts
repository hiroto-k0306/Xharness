export type RewindScope = "code" | "conversation" | "both";
export interface RewindChoice {
  scope: RewindScope;
  includeConflicts: string[];
}
export interface RewindPreview {
  turns: number;
  files: {
    id: string;
    path: string;
    conflict: boolean;
    unavailable?: string;
  }[];
}
export function parseRewindChoice(input: unknown): RewindChoice | undefined {
  if (!input || typeof input !== "object") return;
  const a = input as RewindChoice;
  if (
    !["code", "conversation", "both"].includes(a.scope) ||
    !Array.isArray(a.includeConflicts) ||
    !a.includeConflicts.every((s) => typeof s === "string")
  )
    return;
  return { scope: a.scope, includeConflicts: [...new Set(a.includeConflicts)] };
}
export function rewindTurns(command: string): number | undefined {
  if (command === "/undo") return 1;
  const match = /^\/rewind\s+([1-9]\d*)$/.exec(command);
  if (!match) return;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}
