import { type CandidateQuota } from "../../shared/model-candidates.js";
import { type QuotaUsage } from "../providers/provider.js";
export const QUOTA_FRESH_MS = 5 * 60_000;
type Observation = {
  at: number;
  simulated: boolean;
  used?: number;
  resetAt?: string;
  name: string;
  windowMinutes?: number;
};
/** Observations belong to the current home/provider connection, never inferred from tokens.
 * Missing incoming fields replace rather than rejuvenate older values. No restart restoration. */
export class CandidateQuotas {
  clear(provider: string) {
    this.windows.delete(provider);
    this.failures.delete(provider);
  }
  private windows = new Map<string, Map<string, Observation>>();
  private failures = new Map<
    string,
    { at: number; simulated: boolean; retryAt?: number; scope?: string }
  >();
  observe(
    provider: string,
    windows: QuotaUsage["windows"],
    at: number,
    simulated: boolean,
  ) {
    const rows = this.windows.get(provider) ?? new Map<string, Observation>();
    for (const w of windows)
      rows.set(String(w.windowMinutes ?? w.name), {
        at,
        simulated,
        used:
          Number.isFinite(w.usedPercent) && w.usedPercent! >= 0
            ? w.usedPercent
            : undefined,
        resetAt: w.resetAt,
        name: w.name,
        windowMinutes: w.windowMinutes,
      });
    this.windows.set(provider, rows);
  }
  limited(
    provider: string,
    at: number,
    simulated: boolean,
    retryAfterSec?: number,
    scope?: string,
  ) {
    const retryAt =
      Number.isFinite(retryAfterSec) && retryAfterSec! >= 0
        ? at + retryAfterSec! * 1000
        : undefined;
    this.failures.set(provider, {
      at,
      simulated,
      scope,
      retryAt:
        retryAt !== undefined &&
        Number.isFinite(retryAt) &&
        Math.abs(retryAt) <= 8.64e15
          ? retryAt
          : undefined,
    });
  }
  view(provider: string, now: number): CandidateQuota {
    const rows = [...(this.windows.get(provider)?.values() ?? [])],
      failure = this.failures.get(provider);
    const fresh = (at: number) => at <= now && now - at <= QUOTA_FRESH_MS;
    const exhausted = rows.filter(
      (w) =>
        !w.simulated &&
        w.used !== undefined &&
        w.used >= 100 &&
        fresh(w.at) &&
        (!w.resetAt ||
          Date.parse(w.resetAt) > now ||
          !Number.isFinite(Date.parse(w.resetAt))),
    );
    const failed =
      failure &&
      !failure.simulated &&
      fresh(failure.at) &&
      (failure.retryAt === undefined || failure.retryAt > now);
    const observedAt = Math.max(
      ...rows.map((w) => w.at),
      failure?.at ?? -Infinity,
    );
    const reasons = rows.map(
      (w) =>
        `${w.name} (${w.windowMinutes ?? "不明"}分): ${w.used ?? "不明"}% / ${new Date(w.at).toISOString()} / ${w.simulated ? "模擬" : fresh(w.at) ? "5分以内" : "古い・時刻不正"}${w.resetAt ? ` / reset ${w.resetAt}` : " / reset不明"}`,
    );
    if (failure)
      reasons.push(
        `429 scope ${failure.scope ?? "不明"}: ${new Date(failure.at).toISOString()} / ${failure.simulated ? "模擬" : fresh(failure.at) ? "5分以内" : "古い"} / 再確認hint ${failure.retryAt === undefined ? "不明" : new Date(failure.retryAt).toISOString()} / 回復成功は未確認`,
      );
    const state: CandidateQuota["state"] =
      exhausted.length || failed
        ? "exhausted"
        : (rows.length || failure) &&
            rows.every((w) => w.simulated) &&
            (!failure || failure.simulated)
          ? "simulated"
          : rows.some(
                (w) =>
                  !w.simulated &&
                  w.used !== undefined &&
                  fresh(w.at) &&
                  (!w.resetAt || Date.parse(w.resetAt) > now),
              )
            ? "observed"
            : rows.length || failure
              ? "stale"
              : "unknown";
    reasons.push(
      "provider接続内の共有枠範囲は不明。同providerの全モデルに保守的に適用。残量・成功・トークンからの枠消費は推定しません。",
    );
    return {
      state,
      scope: "provider-pool-unknown",
      observedAt: Number.isFinite(observedAt) ? observedAt : undefined,
      reasons,
    };
  }
}
