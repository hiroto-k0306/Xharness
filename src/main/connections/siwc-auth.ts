import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type JsonWebKey,
} from "node:crypto";
import { BoundaryError } from "./contracts.js";
import {
  boundedJson,
  abortable,
  SIWC_ISSUER,
  SIWC_RESOURCE,
  type Http,
} from "./siwc-http-utils.js";

export interface SiwcGrant {
  issuer: typeof SIWC_ISSUER;
  clientId: string;
  subject: string;
  hostId: string;
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt: number;
  savedAt: number;
  earliestRefreshAt?: number;
}
export interface VerifiedIdentity {
  subject: string;
}
export type IdVerifier = (
  token: string,
  expected: { clientId: string; nonce?: string },
  signal: AbortSignal,
) => Promise<VerifiedIdentity>;
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const text = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 100_000;
const issuedId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-zA-Z0-9_-]{1,200}$/.test(v) &&
  v !== "dynamic_agent_client";
export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}
function callbackUri(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    u.hostname !== "127.0.0.1" ||
    !u.port ||
    u.pathname !== "/auth/callback" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw new BoundaryError("malformed");
  return u.href;
}
/** One-shot PKCE attempt. Construction only builds a URL; no browser, HTTP or storage. */
export class SiwcAttempt {
  #options: {
    hostId: string;
    redirectUri: string;
    selected?: { clientId: string; subject: string; idToken?: string };
    requestPlanConsent?: boolean;
    pendingClientId?: string;
    timeoutMs?: number;
  };
  #state = randomBytes(32).toString("base64url");
  #nonce = randomBytes(32).toString("base64url");
  #verifier = randomBytes(32).toString("base64url");
  #used = false;
  #retryClientId?: string;
  #deadline: number;
  readonly redirectUri: string;
  readonly authorizationUrl: string;
  constructor(
    options: {
      hostId: string;
      redirectUri: string;
      selected?: { clientId: string; subject: string; idToken?: string };
      requestPlanConsent?: boolean;
      pendingClientId?: string;
      timeoutMs?: number;
    },
    private idVerifier: IdVerifier = openaiIdVerifier(),
    private http: Http = fetch,
  ) {
    this.#options = structuredClone(options);
    this.redirectUri = callbackUri(options.redirectUri);
    if (
      !text(options.hostId) ||
      (options.pendingClientId !== undefined &&
        (!issuedId(options.pendingClientId) || !!options.selected)) ||
      (options.selected &&
        (!issuedId(options.selected.clientId) ||
          !text(options.selected.subject)))
    )
      throw new BoundaryError("malformed");
    const timeout = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000)
      throw new BoundaryError("malformed");
    this.#deadline = Date.now() + timeout;
    const url = new URL(`${SIWC_ISSUER}/api/accounts/authorize`);
    const params = {
      client_id:
        options.selected?.clientId ??
        options.pendingClientId ??
        "dynamic_agent_client",
      ...(!options.selected && !options.pendingClientId
        ? { agent_name_hint: "XHarness" }
        : {}),
      ext_agent_host_id: options.hostId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      scope:
        "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource: SIWC_RESOURCE,
      ...(options.selected?.idToken
        ? { id_token_hint: options.selected.idToken }
        : {}),
      ...(options.requestPlanConsent ? { prompt: "consent" } : {}),
      state: this.#state,
      nonce: this.#nonce,
      code_challenge_method: "S256",
      code_challenge: pkceChallenge(this.#verifier),
    };
    url.search = new URLSearchParams(params).toString();
    this.authorizationUrl = url.href;
  }
  discard() {
    this.#used = true;
    this.#state = this.#nonce = this.#verifier = "";
  }
  /** Unverified registration metadata only; never an activated account or a reusable code. */
  get retryClientId() {
    return this.#retryClientId;
  }
  async finish(callback: string, signal: AbortSignal): Promise<SiwcGrant> {
    if (this.#used) throw new BoundaryError("duplicate");
    this.#used = true;
    const inner = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, this.#deadline - Date.now())),
    ]);
    try {
      if (Date.now() >= this.#deadline) throw new BoundaryError("timeout");
      inner.throwIfAborted();
      const url = new URL(callback),
        expected = new URL(this.redirectUri);
      if (
        url.origin !== expected.origin ||
        url.pathname !== expected.pathname ||
        url.hash ||
        url.username ||
        url.password
      )
        throw new BoundaryError("malformed");
      for (const key of url.searchParams.keys())
        if (url.searchParams.getAll(key).length !== 1)
          throw new BoundaryError("malformed");
      const state = url.searchParams.get("state") ?? "";
      if (
        state.length !== this.#state.length ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(this.#state))
      )
        throw new BoundaryError("malformed");
      if (url.searchParams.has("error")) throw new BoundaryError("denied");
      const code = url.searchParams.get("code");
      const clientId =
        url.searchParams.get("client_id") ??
        this.#options.selected?.clientId ??
        this.#options.pendingClientId;
      if (
        !text(code) ||
        !issuedId(clientId) ||
        ((this.#options.selected || this.#options.pendingClientId) &&
          clientId !==
            (this.#options.selected?.clientId ?? this.#options.pendingClientId))
      )
        throw new BoundaryError("malformed");
      this.#retryClientId = clientId;
      const response = await abortable(
        this.http(`${SIWC_ISSUER}/api/accounts/oauth/token`, {
          method: "POST",
          signal: inner,
          redirect: "error",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: this.#verifier,
            redirect_uri: this.redirectUri,
            resource: SIWC_RESOURCE,
          }),
        }),
        inner,
      );
      const t = object(await boundedJson(response, inner));
      if (
        !text(t.access_token) ||
        !text(t.id_token) ||
        t.token_type !== "Bearer" ||
        !Number.isSafeInteger(t.expires_in) ||
        (t.expires_in as number) <= 0 ||
        (t.expires_in as number) > 86400 ||
        !text(t.scope) ||
        (t.refresh_token !== undefined && !text(t.refresh_token))
      )
        throw new BoundaryError("malformed");
      const identity = await abortable(
        this.idVerifier(t.id_token, { clientId, nonce: this.#nonce }, inner),
        inner,
      );
      inner.throwIfAborted();
      if (
        !text(identity.subject) ||
        (this.#options.selected &&
          identity.subject !== this.#options.selected.subject)
      )
        throw new BoundaryError("session-mismatch");
      const scopes = [...new Set(t.scope.split(/\s+/).filter(Boolean))];
      // Retain verified identity even if plan use was declined; inference still gates scopes.
      if (scopes.includes("offline_access") && !text(t.refresh_token))
        throw new BoundaryError("malformed");
      const now = Date.now();
      return {
        issuer: SIWC_ISSUER,
        clientId,
        subject: identity.subject,
        hostId: this.#options.hostId,
        idToken: t.id_token,
        accessToken: t.access_token,
        refreshToken: t.refresh_token as string | undefined,
        scopes,
        savedAt: now,
        expiresAt: now + (t.expires_in as number) * 1000,
        ...(Number.isSafeInteger(t.earliest_refresh_at) &&
        (t.earliest_refresh_at as number) > 0
          ? { earliestRefreshAt: (t.earliest_refresh_at as number) * 1000 }
          : {}),
      };
    } catch (error) {
      if (inner.aborted)
        throw new BoundaryError(signal.aborted ? "cancelled" : "timeout");
      if (error instanceof BoundaryError) throw error;
      throw new BoundaryError(
        signal.aborted ? "cancelled" : inner.aborted ? "timeout" : "transport",
      );
    } finally {
      this.discard();
    }
  }
}
/** Signature verification through fixed-issuer discovery/JWKS; no decoding-only trust. */
export function openaiIdVerifier(http: Http = fetch): IdVerifier {
  return async (token, expected, signal) => {
    try {
      const parts = token.split(".");
      if (
        parts.length !== 3 ||
        parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)) ||
        token.length > 100_000
      )
        throw new BoundaryError("malformed");
      const header = object(
        JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")),
      );
      const claims = object(
        JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")),
      );
      if (
        header.alg !== "RS256" ||
        !text(header.kid) ||
        header.crit !== undefined
      )
        throw new BoundaryError("malformed");
      const discovery = object(
        await boundedJson(
          await http(`${SIWC_ISSUER}/.well-known/openid-configuration`, {
            signal,
            redirect: "error",
          }),
          signal,
        ),
      );
      const jwksUrl = new URL(String(discovery.jwks_uri));
      if (
        discovery.issuer !== SIWC_ISSUER ||
        jwksUrl.origin !== SIWC_ISSUER ||
        jwksUrl.username ||
        jwksUrl.password ||
        jwksUrl.hash ||
        jwksUrl.search
      )
        throw new BoundaryError("malformed");
      const jwks = object(
        await boundedJson(
          await http(jwksUrl.href, { signal, redirect: "error" }),
          signal,
        ),
      );
      const candidates = Array.isArray(jwks.keys)
        ? jwks.keys
            .map(object)
            .filter(
              (k) =>
                k.kid === header.kid &&
                k.kty === "RSA" &&
                (k.use === undefined || k.use === "sig") &&
                (k.alg === undefined || k.alg === "RS256"),
            )
        : [];
      if (
        candidates.length !== 1 ||
        !verify(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          createPublicKey({ key: candidates[0] as JsonWebKey, format: "jwk" }),
          Buffer.from(parts[2]!, "base64url"),
        )
      )
        throw new BoundaryError("malformed");
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      const now = Date.now() / 1000;
      if (
        claims.iss !== SIWC_ISSUER ||
        !audience.includes(expected.clientId) ||
        (audience.length > 1 && claims.azp !== expected.clientId) ||
        !Number.isSafeInteger(claims.exp) ||
        (claims.exp as number) <= now ||
        (claims.nbf !== undefined &&
          (!Number.isSafeInteger(claims.nbf) ||
            (claims.nbf as number) > now)) ||
        (expected.nonce !== undefined && claims.nonce !== expected.nonce) ||
        !text(claims.sub)
      )
        throw new BoundaryError("malformed");
      signal.throwIfAborted();
      return { subject: claims.sub };
    } catch {
      throw new BoundaryError(signal.aborted ? "cancelled" : "malformed");
    }
  };
}
