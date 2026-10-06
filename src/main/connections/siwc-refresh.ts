import { BoundaryError } from "./contracts.js";
import {
  openaiIdVerifier,
  type IdVerifier,
  type SiwcGrant,
} from "./siwc-auth.js";
import {
  abortable,
  boundedJson,
  SIWC_ISSUER,
  SIWC_RESOURCE,
  type Http,
} from "./siwc-http-utils.js";
export class SiwcRefreshFailure extends BoundaryError {
  constructor(readonly terminal: boolean) {
    super(terminal ? "denied" : "transport");
  }
}
const revoked = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);
/** Caller holds the vault lease and serializes rotation; no retry of ambiguous refresh. */
export async function refreshSiwc(
  grant: SiwcGrant,
  signal: AbortSignal,
  http: Http = fetch,
  verify: IdVerifier = openaiIdVerifier(http),
): Promise<SiwcGrant> {
  const inner = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  try {
    if (!grant.refreshToken || (grant.earliestRefreshAt ?? 0) > Date.now())
      throw new BoundaryError("unconfigured");
    const response = await abortable(
      http(`${SIWC_ISSUER}/api/accounts/oauth/token`, {
        method: "POST",
        signal: inner,
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: grant.clientId,
          refresh_token: grant.refreshToken,
          resource: SIWC_RESOURCE,
        }),
      }),
      inner,
    );
    const data = (await boundedJson(
      new Response(response.body, { status: 200 }),
      inner,
    )) as Record<string, unknown>;
    if (!response.ok)
      throw new SiwcRefreshFailure(revoked.has(String(data.error)));
    if (
      !data ||
      typeof data !== "object" ||
      data.token_type !== "Bearer" ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      typeof data.id_token !== "string" ||
      !data.id_token ||
      typeof data.scope !== "string" ||
      !Number.isSafeInteger(data.expires_in) ||
      (data.expires_in as number) < 1 ||
      (data.expires_in as number) > 86400 ||
      [data.access_token, data.refresh_token, data.id_token].some(
        (t) => (t as string).length > 100000,
      )
    )
      throw new SiwcRefreshFailure(false);
    const identity = await abortable(
      verify(data.id_token, { clientId: grant.clientId }, inner),
      inner,
    );
    if (identity.subject !== grant.subject) throw new SiwcRefreshFailure(true);
    inner.throwIfAborted();
    const now = Date.now();
    return {
      ...grant,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      scopes: [...new Set(data.scope.split(/\s+/).filter(Boolean))],
      savedAt: now,
      expiresAt: now + (data.expires_in as number) * 1000,
      earliestRefreshAt:
        Number.isSafeInteger(data.earliest_refresh_at) &&
        (data.earliest_refresh_at as number) > 0
          ? (data.earliest_refresh_at as number) * 1000
          : undefined,
    };
  } catch (e) {
    if (inner.aborted)
      throw new BoundaryError(signal.aborted ? "cancelled" : "timeout");
    if (e instanceof BoundaryError) throw e;
    throw new SiwcRefreshFailure(false);
  }
}
/** One best-effort revocation; local sign-out remains explicit if remote confirmation fails. */
export async function revokeSiwc(
  grant: SiwcGrant,
  signal: AbortSignal,
  http: Http = fetch,
): Promise<boolean> {
  if (!grant.refreshToken) return true;
  const inner = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
  try {
    const discovery = (await boundedJson(
      await abortable(
        http(`${SIWC_ISSUER}/.well-known/openid-configuration`, {
          signal: inner,
          redirect: "error",
        }),
        inner,
      ),
      inner,
    )) as Record<string, unknown>;
    const endpoint = new URL(String(discovery.revocation_endpoint));
    if (
      discovery.issuer !== SIWC_ISSUER ||
      endpoint.origin !== SIWC_ISSUER ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      return false;
    const response = await abortable(
      http(endpoint.href, {
        method: "POST",
        signal: inner,
        redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: grant.refreshToken,
          token_type_hint: "refresh_token",
          client_id: grant.clientId,
        }),
      }),
      inner,
    );
    void response.body?.cancel();
    return response.status === 200;
  } catch {
    return false;
  }
}
