/** Native provider skill selection. Bodies stay in the trusted main process. */
export interface OfficialSkillSelection {
  provider: "claude" | "codex";
  scope: "user" | "project";
  name: string;
  source: string;
  hash: string;
  bundleHash: string;
}
export interface OfficialSkillEntry extends OfficialSkillSelection {
  description: string;
  eligible: boolean;
  reasons: string[];
}
export interface OfficialSkillCatalog {
  entries: OfficialSkillEntry[];
  limits: Record<string, number>;
}
export interface OfficialSkillBundle extends OfficialSkillSelection {
  files: { relativePath: string; body: string; hash: string }[];
}
export interface OfficialSkillPreview {
  entry: OfficialSkillEntry;
  files?: OfficialSkillBundle["files"];
}
/** Dispatch is not proof that a skill was invoked or completed. */
export interface OfficialSkillEvidence {
  requested: OfficialSkillSelection[];
  dispatched?: {
    name: string;
    mechanism: "claude-plugin" | "codex-skill-input";
  }[];
  observed?: {
    name: string;
    status: "requested" | "allowed" | "completed" | "denied";
  }[];
}
export type OfficialSkillAction =
  | { action: "list"; provider: "claude" | "codex" }
  | { action: "preview"; provider: "claude" | "codex"; source: string }
  | { action: "select"; selection: OfficialSkillSelection }
  | { action: "clear" };
export interface OfficialSkillsView {
  catalog?: OfficialSkillCatalog;
  preview?: OfficialSkillPreview;
  selected: OfficialSkillSelection[];
}

const shape = (
  value: unknown,
  keys: string[],
): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const provider = (
  value: unknown,
): value is OfficialSkillSelection["provider"] =>
  value === "claude" || value === "codex";
const source = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    return false;
  const normalized = value.replaceAll("\\", "/");
  if (
    !/^(?:\/|[A-Za-z]:\/)/.test(normalized) ||
    !normalized.endsWith("/SKILL.md")
  )
    return false;
  return !normalized
    .split("/")
    .some(
      (part, index) => part === "." || part === ".." || (!part && index !== 0),
    );
};
/** Strict metadata-only IPC. Source ownership and current hashes are verified in main. */
export function parseOfficialSkillAction(
  value: unknown,
): OfficialSkillAction | undefined {
  if (shape(value, ["action"]) && value.action === "clear")
    return { action: "clear" };
  if (
    shape(value, ["action", "provider"]) &&
    value.action === "list" &&
    provider(value.provider)
  )
    return { action: "list", provider: value.provider };
  if (
    shape(value, ["action", "provider", "source"]) &&
    value.action === "preview" &&
    provider(value.provider) &&
    source(value.source)
  )
    return {
      action: "preview",
      provider: value.provider,
      source: value.source,
    };
  if (!shape(value, ["action", "selection"]) || value.action !== "select")
    return;
  const item = value.selection;
  if (
    !shape(item, [
      "provider",
      "scope",
      "name",
      "source",
      "hash",
      "bundleHash",
    ]) ||
    !provider(item.provider) ||
    !["user", "project"].includes(String(item.scope)) ||
    typeof item.name !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.name) ||
    !source(item.source) ||
    typeof item.hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.hash) ||
    typeof item.bundleHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(item.bundleHash)
  )
    return;
  return {
    action: "select",
    selection: {
      provider: item.provider,
      scope: item.scope as "user" | "project",
      name: item.name,
      source: item.source,
      hash: item.hash,
      bundleHash: item.bundleHash,
    },
  };
}
