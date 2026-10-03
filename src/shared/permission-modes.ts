export const permissionModeLabels = {
  default: "通常",
  acceptEdits: "自動",
  plan: "計画",
} as const;

/** Keep stored values compatible; accept Japanese labels and old names. */
export function resolvePermissionMode(value: string | undefined) {
  switch (value) {
    case "default":
    case "通常":
      return "default";
    case "auto":
    case "自動":
    case "acceptEdits":
      return "acceptEdits";
    case "plan":
    case "計画":
      return "plan";
    default:
      return undefined;
  }
}
