const sensitiveKey =
  /token|authorization|account.?id|organization.?id|workspace.?id|user.?id|safety_identifier|secret|password|api.?key|cookie/i;

const tokenCountKey =
  /^(?:input|output|total|max|max_output|cache_creation_input|cache_read_input|ephemeral_5m_input|ephemeral_1h_input|cache_write|cached|reasoning|image|text|reminder_threshold|auto_compact_fallback_buffer)_tokens$|^auto_compact_token_limit$/;

function isSensitiveField(key: string, value: unknown): boolean {
  if (
    /^(?:(?:input|output)_tokens_details|token_budget)$/.test(key) &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  )
    return false;
  if (
    tokenCountKey.test(key) &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
    return false;
  return isSensitiveKey(key);
}

export function isSensitiveKey(key: string): boolean {
  return sensitiveKey.test(key);
}

export function mask(value: string): string {
  return value.length > 6 ? value.slice(0, 6) + "…" : "[REDACTED]";
}

function embeddedJson(value: string): unknown {
  if (!/^[\s]*[\[{]/.test(value)) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

// Discover sensitive values first so copies in error messages are masked too.
export function maskSecrets(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  const discovered = new Set(secrets.filter(Boolean));
  const collect = (item: unknown, sensitive = false): void => {
    if (typeof item === "string") {
      if (sensitive && item) discovered.add(item);
      else {
        const json = embeddedJson(item);
        if (json !== undefined) collect(json);
      }
    } else if (typeof item === "number" && sensitive)
      discovered.add(String(item));
    else if (Array.isArray(item))
      item.forEach((child) => collect(child, sensitive));
    else if (item && typeof item === "object")
      Object.entries(item).forEach(([key, child]) =>
        collect(child, sensitive || isSensitiveField(key, child)),
      );
  };
  collect(value);
  const ordered = [...discovered].sort((a, b) => b.length - a.length);
  const pattern = ordered.map((secret) =>
    secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const redactText = (text: string): string => {
    // Replace in one pass: replacement text must never become a new match.
    let result = pattern.length
      ? text.replace(new RegExp(pattern.join("|"), "g"), (secret) =>
          mask(secret),
        )
      : text;
    result = result.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
    result = result.replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED]",
    );
    return result.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  };
  const visit = (item: unknown, sensitive = false): unknown => {
    if (typeof item === "string") {
      if (sensitive) return mask(item);
      const json = embeddedJson(item);
      return json !== undefined
        ? JSON.stringify(visit(json))
        : redactText(item);
    }
    if (Array.isArray(item))
      return item.map((child) => visit(child, sensitive));
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => [
          key,
          visit(child, sensitive || isSensitiveField(key, child)),
        ]),
      );
    return sensitive && item != null ? "[REDACTED]" : item;
  };
  return visit(value);
}
