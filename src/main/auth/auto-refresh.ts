import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ProviderName } from "../../shared/ipc.js";

export interface AuthSettings {
  autoRefresh: boolean;
  claudeCliPath?: string;
  codexCliPath?: string;
}
export type RefreshResult = {
  result:
    | "success"
    | "unchanged"
    | "timeout"
    | "cli_missing"
    | "failed"
    | "limited"
    | "disabled";
  durationMs: number;
};
export async function credentialExpiry(
  provider: ProviderName,
): Promise<number | undefined> {
  try {
    const directory =
      provider === "claude"
        ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
        : process.env.CODEX_HOME || join(homedir(), ".codex");
    const data = JSON.parse(
      await readFile(
        join(
          directory,
          provider === "claude" ? ".credentials.json" : "auth.json",
        ),
        "utf8",
      ),
    );
    const expiry =
      provider === "claude"
        ? data.claudeAiOauth?.expiresAt
        : JSON.parse(
            Buffer.from(
              data.tokens.access_token.split(".")[1],
              "base64url",
            ).toString(),
          ).exp * 1000;
    return typeof expiry === "number" && Number.isFinite(expiry)
      ? expiry
      : undefined;
  } catch {
    return undefined;
  }
}

/** One shared instance per application, including all workers. No credential writes. */
export class AutoRefresh {
  private flights = new Map<ProviderName, Promise<RefreshResult>>();
  private lastAttempt = new Map<ProviderName, number>();
  constructor(
    private readonly options: {
      settings(): Promise<AuthSettings>;
      expiry?(provider: ProviderName): Promise<number | undefined>;
      execute(
        provider: ProviderName,
        path?: string,
      ): Promise<RefreshResult["result"]>;
      now?: () => number;
      changed?(): Promise<void>;
      claim?(provider: ProviderName, now: number): Promise<boolean>;
    },
  ) {}
  expiry(provider: ProviderName) {
    return (this.options.expiry ?? credentialExpiry)(provider);
  }
  refresh(
    provider: ProviderName,
    observedExpiry: number | undefined,
  ): Promise<RefreshResult> {
    const existing = this.flights.get(provider);
    if (existing) return existing;
    const promise = this.run(provider, observedExpiry).finally(() =>
      this.flights.delete(provider),
    );
    this.flights.set(provider, promise);
    return promise;
  }
  private async run(
    provider: ProviderName,
    before: number | undefined,
  ): Promise<RefreshResult> {
    const now = this.options.now ?? Date.now;
    const start = now();
    const done = (result: RefreshResult["result"]): RefreshResult => ({
      result,
      durationMs: Math.max(0, now() - start),
    });
    try {
      const settings = await this.options.settings();
      if (!settings.autoRefresh) return done("disabled");
      const current = await this.expiry(provider);
      // Another request/official CLI already updated the credential we used.
      if (
        current !== undefined &&
        before !== undefined &&
        current > before &&
        current > now()
      )
        return done("success");
      const last = this.lastAttempt.get(provider);
      if (last !== undefined && now() - last < 600_000) return done("limited");
      this.lastAttempt.set(provider, now());
      if (this.options.claim && !(await this.options.claim(provider, now())))
        return done("limited");
      const result = await this.options.execute(
        provider,
        provider === "claude" ? settings.claudeCliPath : settings.codexCliPath,
      );
      const after = await this.expiry(provider);
      await this.options.changed?.();
      if (result !== "success") return done(result);
      return done(
        after !== undefined &&
          before !== undefined &&
          after > before &&
          after > now()
          ? "success"
          : "unchanged",
      );
    } catch {
      return done("failed");
    }
  }
}
