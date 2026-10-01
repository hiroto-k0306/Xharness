import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Provider = "claude" | "codex";
type Structure = string | { [key: string]: Structure } | Structure[];

interface CredentialReport {
  provider: Provider;
  status:
    | "invalid-root"
    | "oauth-present"
    | "oauth-missing"
    | "file-missing"
    | "read-failed"
    | "invalid-json";
  structure?: Structure;
  expiry?: ReturnType<typeof expiry>;
  idToken?: ReturnType<typeof inspectIdToken>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Only key names and types leave this module. No credential values are logged.
export function keyStructure(value: unknown): Structure {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(keyStructure);
  const record = object(value);
  return record
    ? Object.fromEntries(
        Object.entries(record).map(([key, child]) => [
          key,
          keyStructure(child),
        ]),
      )
    : typeof value;
}

function expiry(value: unknown, now: number, scale = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const milliseconds = value * scale;
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.getTime())) return undefined;
  return {
    expiresAt: date.toISOString(),
    minutesRemaining: Math.floor((milliseconds - now) / 60_000),
    expired: milliseconds <= now,
  };
}

function inspectIdToken(value: unknown, now: number) {
  if (typeof value !== "string") return { status: "absent" };
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1] || !/^[\w-]+$/.test(parts[1]))
    return { status: "invalid" };
  try {
    const payload = object(
      JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    );
    if (!payload) return { status: "invalid" };
    const planKeyPaths: string[] = [];
    const walk = (item: unknown, path: string[]): void => {
      if (Array.isArray(item)) {
        item.forEach((child, index) => walk(child, [...path, String(index)]));
      } else {
        for (const [key, child] of Object.entries(object(item) ?? {})) {
          const next = [...path, key];
          if (/plan/i.test(key)) planKeyPaths.push(next.join(" / "));
          walk(child, next);
        }
      }
    };
    walk(payload, []);
    return {
      status: "decoded-unverified",
      structure: keyStructure(payload),
      expiry: expiry(payload.exp, now, 1000),
      planKeyPaths,
    };
  } catch {
    // JSON parser errors may echo the payload; never propagate them.
    return { status: "invalid" };
  }
}

export function inspectCredentials(
  provider: Provider,
  value: unknown,
  now = Date.now(),
): CredentialReport {
  const root = object(value);
  if (!root) return { provider, status: "invalid-root" };
  const credentials = object(
    provider === "claude" ? root.claudeAiOauth : root.tokens,
  );
  const accessToken =
    provider === "claude"
      ? credentials?.accessToken
      : credentials?.access_token;
  return {
    provider,
    status:
      typeof accessToken === "string" && accessToken.length > 0
        ? "oauth-present"
        : "oauth-missing",
    structure: keyStructure(root),
    ...(provider === "claude"
      ? { expiry: expiry(credentials?.expiresAt, now) }
      : { idToken: inspectIdToken(credentials?.id_token, now) }),
  };
}

export function credentialPath(provider: Provider): string {
  return provider === "claude"
    ? join(
        process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
        ".credentials.json",
      )
    : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

export async function readCredentialReport(
  provider: Provider,
  path = credentialPath(provider),
): Promise<CredentialReport> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    const code = object(error)?.code;
    return {
      provider,
      status: code === "ENOENT" ? "file-missing" : "read-failed",
    };
  }
  try {
    return inspectCredentials(provider, JSON.parse(contents));
  } catch {
    return { provider, status: "invalid-json" };
  }
}

export async function runCredentialInspection(provider: Provider) {
  const report = await readCredentialReport(provider);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "oauth-present") process.exitCode = 1;
}
