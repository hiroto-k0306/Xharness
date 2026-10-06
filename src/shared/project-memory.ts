export const MEMORY_KINDS = ["decision", "failure", "recipe"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export interface MemorySourceInput {
  sessionId: string;
  messageLine: number;
  receiptId?: string;
}
export interface MemoryDraft {
  kind: MemoryKind;
  topic: string;
  content: string;
  sources: MemorySourceInput[];
  expiresAt?: number;
  mergeSuggested?: string;
}
export interface MemorySource extends MemorySourceInput {
  sessionCreatedAt: string;
  sessionUpdatedAt: string;
  messageHash: string;
  role: string;
  evidence: "model_claim" | "user_statement" | "tool_result";
  tool?: string;
  result?: "completed" | "error";
  resultHash?: string;
}
export interface MemoryEntry extends Omit<MemoryDraft, "sources"> {
  id: string;
  revision: number;
  scope: string;
  sources: MemorySource[];
  createdAt: number;
  updatedAt: number;
  status: "candidate" | "accepted" | "rejected" | "invalidated";
  confidence: "unverified" | "user_reviewed";
  origin: "agent" | "manual";
}
export interface MemoryView extends MemoryEntry {
  sourceUnavailable: boolean;
  expired: boolean;
  related: { id: string; relation: "duplicate" | "possible_conflict" }[];
}
export interface MemoryList {
  entries: MemoryView[];
  scope: string;
  warnings: string[];
  limit: number;
}
export type MemoryAction =
  | { action: "list" }
  | { action: "add"; draft: MemoryDraft }
  | {
      action: "accept" | "edit" | "merge";
      id: string;
      revision: number;
      draft: MemoryDraft;
      target?: string;
      targetRevision?: number;
    }
  | {
      action: "reject" | "invalidate" | "delete";
      id: string;
      revision: number;
    };
export function parseMemoryDraft(value: unknown): MemoryDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "kind",
          "topic",
          "content",
          "sources",
          "expiresAt",
          "mergeSuggested",
        ].includes(k),
    ) ||
    !MEMORY_KINDS.includes(v.kind as MemoryKind) ||
    typeof v.topic !== "string" ||
    !v.topic.trim() ||
    v.topic.length > 100 ||
    typeof v.content !== "string" ||
    !v.content.trim() ||
    v.content.length > 2000 ||
    !Array.isArray(v.sources) ||
    v.sources.length > 3 ||
    (v.expiresAt !== undefined &&
      (!Number.isFinite(v.expiresAt) ||
        Number(v.expiresAt) < 0 ||
        !Number.isFinite(new Date(Number(v.expiresAt)).getTime()))) ||
    (v.mergeSuggested !== undefined &&
      (typeof v.mergeSuggested !== "string" ||
        !/^[\w-]{1,128}$/.test(v.mergeSuggested)))
  )
    return undefined;
  if (
    !v.sources.every(
      (s) =>
        s &&
        typeof s === "object" &&
        Object.keys(s).every((k) =>
          ["sessionId", "messageLine", "receiptId"].includes(k),
        ) &&
        typeof s.sessionId === "string" &&
        /^[\w-]{1,128}$/.test(s.sessionId) &&
        Number.isSafeInteger(s.messageLine) &&
        s.messageLine > 0 &&
        (s.receiptId === undefined ||
          (typeof s.receiptId === "string" &&
            /^#[0-9]{4,12}$/.test(s.receiptId))),
    )
  )
    return undefined;
  return v as unknown as MemoryDraft;
}
export function parseMemoryAction(value: unknown): MemoryAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.action === "list") return { action: "list" };
  const draft = parseMemoryDraft(v.draft);
  if (v.action === "add") return draft && { action: "add", draft };
  if (
    typeof v.id !== "string" ||
    !/^[\w-]{1,128}$/.test(v.id) ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 1
  )
    return undefined;
  if (["reject", "invalidate", "delete"].includes(String(v.action)))
    return { action: v.action, id: v.id, revision: v.revision } as MemoryAction;
  if (
    ["accept", "edit", "merge"].includes(String(v.action)) &&
    draft &&
    (v.action !== "merge" ||
      (typeof v.target === "string" &&
        /^[\w-]{1,128}$/.test(v.target) &&
        Number.isSafeInteger(v.targetRevision)))
  )
    return {
      action: v.action,
      id: v.id,
      revision: v.revision,
      draft,
      target: v.target,
      targetRevision: v.targetRevision,
    } as MemoryAction;
  return undefined;
}
