/** Confirmed scope is required before planning; inferred intent never grants write permission. */
export interface OfficialTaskScope {
  files: string[];
  /** One existing, immutable Node test file. No shell, installation or generated tests. */
  testFile: string;
}
export function parseOfficialTaskScope(
  value: unknown,
): OfficialTaskScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !["files", "testFile"].includes(k)) ||
    !Array.isArray(v.files) ||
    !v.files.length ||
    v.files.length > 30 ||
    v.files.some((f) => typeof f !== "string" || !f.trim() || f.length > 500) ||
    typeof v.testFile !== "string" ||
    !v.testFile.trim() ||
    v.testFile.length > 500
  )
    return;
  return { files: [...v.files] as string[], testFile: v.testFile };
}
export interface OfficialSessionSubmission {
  sessionId: string;
  cwd: string;
  /** Source repository for an existing session worktree; supplied by main, never renderer. */
  worktreeSource?: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  text: string;
  task?: OfficialTaskScope;
  history: { role: "user" | "assistant"; text: string }[];
}
export interface OfficialSessionResult {
  taskRequired?: boolean;
  summary: string;
  workflowId: string;
  status: string;
}
