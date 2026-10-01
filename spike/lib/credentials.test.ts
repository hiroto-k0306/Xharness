import { readFile, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectCredentials, readCredentialReport } from "./credentials.js";

const now = Date.UTC(2026, 9, 1);

describe("credential inspection", () => {
  it("only reports types and expiry for Claude without changing input", () => {
    const input = {
      claudeAiOauth: {
        accessToken: "private-access",
        refreshToken: "private-refresh",
        expiresAt: now + 120_000,
        scopes: ["private-scope"],
      },
      account_id: "private-account",
    };
    const before = JSON.stringify(input);
    const report = inspectCredentials("claude", input, now);
    expect(report.status).toBe("oauth-present");
    expect(report.expiry).toEqual({
      expiresAt: "2026-10-01T00:02:00.000Z",
      minutesRemaining: 2,
      expired: false,
    });
    expect(JSON.stringify(report)).not.toContain("private-");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("decodes JWT expiry and plan key names without exposing identity or plan values", () => {
    const payload = {
      exp: now / 1000 - 60,
      email: "private@example.invalid",
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "private-plan",
        chatgpt_account_id: "private-account",
      },
    };
    const token = `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
    const report = inspectCredentials(
      "codex",
      { tokens: { access_token: "private-access", id_token: token } },
      now,
    );
    expect(report.idToken).toMatchObject({
      status: "decoded-unverified",
      expiry: { expired: true, minutesRemaining: -1 },
      planKeyPaths: ["https://api.openai.com/auth / chatgpt_plan_type"],
    });
    expect(JSON.stringify(report)).not.toContain("private");
    expect(JSON.stringify(report)).not.toContain(token);
  });

  it.each(["private-invalid", "a.cHJpdmF0ZS1wYXlsb2Fk.z", "a.bnVsbA.z"])(
    "does not echo malformed JWT %s",
    (id_token) => {
      const report = inspectCredentials("codex", { tokens: { id_token } });
      expect(report.idToken).toEqual({ status: "invalid" });
      expect(JSON.stringify(report)).not.toContain(id_token);
    },
  );

  it("handles absent OAuth, invalid roots and invalid expiry", () => {
    expect(inspectCredentials("codex", null).status).toBe("invalid-root");
    expect(
      inspectCredentials("codex", { OPENAI_API_KEY: "private-key" }),
    ).toMatchObject({ status: "oauth-missing", idToken: { status: "absent" } });
    for (const expiresAt of ["private-date", Infinity, 1e20, null]) {
      expect(
        inspectCredentials("claude", { claudeAiOauth: { expiresAt } }).expiry,
      ).toBeUndefined();
    }
  });

  it("reads without modifying files and suppresses parser errors", async () => {
    const path = join(tmpdir(), `xharness-creds-${randomUUID()}.json`);
    expect((await readCredentialReport("claude", path)).status).toBe(
      "file-missing",
    );
    try {
      const contents = '{"claudeAiOauth":{"accessToken":"private-access"}}';
      await writeFile(path, contents);
      expect((await readCredentialReport("claude", path)).status).toBe(
        "oauth-present",
      );
      expect(await readFile(path, "utf8")).toBe(contents);
      await writeFile(path, "private-invalid-json");
      expect(await readCredentialReport("claude", path)).toEqual({
        provider: "claude",
        status: "invalid-json",
      });
    } finally {
      await unlink(path);
    }
  });
});
