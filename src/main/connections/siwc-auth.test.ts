import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  SiwcAttempt,
  openaiIdVerifier,
  pkceChallenge,
  type IdVerifier,
} from "./siwc-auth.js";
import { SIWC_ISSUER, SIWC_RESOURCE } from "./siwc-http.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const tokens = {
  access_token: "dummy-access-token",
  refresh_token: "dummy-refresh-token",
  id_token: "dummy-id-token",
  token_type: "Bearer",
  expires_in: 3600,
  scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
};
const verifier: IdVerifier = async () => ({ subject: "dummy-subject" });
it("retains verified identity without plan permission and requests extra consent only explicitly", async () => {
  const f = fixture();
  f.http.mockResolvedValueOnce(json({ ...tokens, scope: "openid" }));
  const g = await f.attempt.finish(f.callback, new AbortController().signal);
  expect(g.scopes).toEqual(["openid"]);
  const ordinary = new SiwcAttempt(
    {
      hostId: "dummy-host",
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      selected: {
        clientId: "oaiapp_dummy",
        subject: "dummy-subject",
        idToken: "dummy-retained-id",
      },
    },
    verifier,
    f.http,
  );
  const u = new URL(ordinary.authorizationUrl);
  expect(u.searchParams.get("id_token_hint")).toBe("dummy-retained-id");
  expect(u.searchParams.has("prompt")).toBe(false);
  ordinary.discard();
  const consent = new SiwcAttempt(
    {
      hostId: "dummy-host",
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      selected: { clientId: "oaiapp_dummy", subject: "dummy-subject" },
      requestPlanConsent: true,
    },
    verifier,
    f.http,
  );
  expect(new URL(consent.authorizationUrl).searchParams.get("prompt")).toBe(
    "consent",
  );
  consent.discard();
});
it("discards expired state without code exchange", async () => {
  const remote = vi.fn<typeof fetch>();
  const a = new SiwcAttempt(
    {
      hostId: "dummy-host",
      redirectUri: "http://127.0.0.1:1455/auth/callback",
      timeoutMs: 1,
    },
    verifier,
    remote,
  );
  await new Promise((r) => setTimeout(r, 5));
  const u = new URL(a.redirectUri);
  u.search = new URLSearchParams({
    state: new URL(a.authorizationUrl).searchParams.get("state")!,
    client_id: "oaiapp_dummy",
    code: "dummy-code",
  }).toString();
  await expect(a.finish(u.href, new AbortController().signal)).rejects.toThrow(
    "timeout",
  );
  await expect(a.finish(u.href, new AbortController().signal)).rejects.toThrow(
    "duplicate",
  );
  expect(remote).not.toHaveBeenCalled();
});
function fixture(selected?: { clientId: string; subject: string }) {
  const http = vi.fn<typeof fetch>(async () => json(tokens));
  const attempt = new SiwcAttempt(
    {
      hostId: "dummy-host",
      redirectUri: "http://127.0.0.1:54321/auth/callback",
      selected,
    },
    verifier,
    http,
  );
  const state = new URL(attempt.authorizationUrl).searchParams.get("state")!;
  const callback = `${attempt.redirectUri}?code=dummy-code&state=${state}&client_id=oaiapp_dummy`;
  return { attempt, http, state, callback };
}
it("creates fresh PKCE S256/state/nonce and exchanges with issued ID and exact redirect", async () => {
  expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
  const f = fixture(),
    g = fixture();
  const url = new URL(f.attempt.authorizationUrl);
  expect(url.origin + url.pathname).toBe(
    `${SIWC_ISSUER}/api/accounts/authorize`,
  );
  expect(url.searchParams.get("client_id")).toBe("dynamic_agent_client");
  expect(url.searchParams.get("agent_name_hint")).toBe("XHarness");
  expect(url.searchParams.get("state")).not.toBe(g.state);
  expect(url.searchParams.get("nonce")).not.toBe(
    new URL(g.attempt.authorizationUrl).searchParams.get("nonce"),
  );
  const grant = await f.attempt.finish(
    f.callback,
    new AbortController().signal,
  );
  expect(grant.clientId).toBe("oaiapp_dummy");
  expect(grant.subject).toBe("dummy-subject");
  const [endpoint, request] = f.http.mock.calls[0]!;
  const form = request!.body as URLSearchParams;
  expect(endpoint).toBe(`${SIWC_ISSUER}/api/accounts/oauth/token`);
  expect(request!.redirect).toBe("error");
  expect(form.get("client_id")).toBe("oaiapp_dummy");
  expect(form.get("redirect_uri")).toBe(f.attempt.redirectUri);
  expect(form.get("resource")).toBe(SIWC_RESOURCE);
  expect(pkceChallenge(form.get("code_verifier")!)).toBe(
    url.searchParams.get("code_challenge"),
  );
  await expect(
    f.attempt.finish(f.callback, new AbortController().signal),
  ).rejects.toThrow("duplicate");
});
it.each([
  "http://localhost:1/auth/callback",
  "http://127.0.0.1:1/callback",
  "https://127.0.0.1:1/auth/callback",
  "http://127.0.0.1:1/auth/callback#x",
])("rejects invalid callback URI %s before HTTP", (redirectUri) => {
  expect(
    () => new SiwcAttempt({ hostId: "dummy-host", redirectUri }, verifier),
  ).toThrow("malformed");
});
it.each([
  "state",
  "port",
  "path",
  "duplicate-state",
  "missing-client",
  "entrypoint-client",
  "denied",
])("discards invalid %s callback before exchange", async (kind) => {
  const f = fixture(),
    u = new URL(f.callback);
  if (kind === "state") u.searchParams.set("state", "wrong");
  if (kind === "port") u.port = "54322";
  if (kind === "path") u.pathname = "/callback";
  if (kind === "duplicate-state") u.searchParams.append("state", f.state);
  if (kind === "missing-client") u.searchParams.delete("client_id");
  if (kind === "entrypoint-client")
    u.searchParams.set("client_id", "dynamic_agent_client");
  if (kind === "denied") u.searchParams.set("error", "access_denied");
  await expect(
    f.attempt.finish(u.href, new AbortController().signal),
  ).rejects.toThrow();
  expect(f.http).not.toHaveBeenCalled();
  await expect(
    f.attempt.finish(f.callback, new AbortController().signal),
  ).rejects.toThrow("duplicate");
});
it("returning account retains issued ID; rejects changed registration/identity", async () => {
  const selected = { clientId: "oaiapp_dummy", subject: "dummy-subject" };
  const f = fixture(selected),
    u = new URL(f.callback);
  const auth = new URL(f.attempt.authorizationUrl);
  expect(auth.searchParams.get("client_id")).toBe(selected.clientId);
  expect(auth.searchParams.has("agent_name_hint")).toBe(false);
  expect(JSON.stringify(f.attempt)).not.toContain(selected.subject);
  u.searchParams.delete("client_id");
  expect(
    (await f.attempt.finish(u.href, new AbortController().signal)).subject,
  ).toBe(selected.subject);
  const bad = fixture(selected);
  const changed = new URL(bad.callback);
  changed.searchParams.set("client_id", "other_client");
  await expect(
    bad.attempt.finish(changed.href, new AbortController().signal),
  ).rejects.toThrow("malformed");
  expect(bad.http).not.toHaveBeenCalled();
  const mismatch = fixture({ ...selected, subject: "another-subject" });
  await expect(
    mismatch.attempt.finish(mismatch.callback, new AbortController().signal),
  ).rejects.toThrow("session-mismatch");
});
it("rejects invalid_grant, expiry and secret native errors without retry", async () => {
  for (const response of [
    json({ error: "invalid_grant", secret: "dummy-code" }, 400),
    json({ ...tokens, expires_in: 0 }),
  ]) {
    const f = fixture();
    f.http.mockResolvedValueOnce(response);
    await expect(
      f.attempt.finish(f.callback, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.http).toHaveBeenCalledTimes(1);
    await expect(
      f.attempt.finish(f.callback, new AbortController().signal),
    ).rejects.toThrow("duplicate");
  }
  const f = fixture();
  f.http.mockRejectedValueOnce(new Error("dummy-access-token dummy-code"));
  const error = await f.attempt
    .finish(f.callback, new AbortController().signal)
    .catch((e) => e as Error);
  expect(String(error)).toBe("Error: transport");
});
it("cancels an uncooperative exchange and discards late success", async () => {
  const f = fixture(),
    abort = new AbortController();
  let release!: (r: Response) => void;
  f.http.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const work = f.attempt.finish(f.callback, abort.signal);
  abort.abort();
  await expect(work).rejects.toThrow("cancelled");
  release(json(tokens));
  await expect(
    f.attempt.finish(f.callback, new AbortController().signal),
  ).rejects.toThrow("duplicate");
});
it("retains only an unverified issued client for an explicit fresh attempt after invalid_grant", async () => {
  const f = fixture();
  f.http.mockResolvedValueOnce(json({ error: "invalid_grant" }, 400));
  await expect(
    f.attempt.finish(f.callback, new AbortController().signal),
  ).rejects.toThrow("transport");
  expect(f.attempt.retryClientId).toBe("oaiapp_dummy");
  const fresh = new SiwcAttempt(
    {
      hostId: "dummy-host",
      redirectUri: f.attempt.redirectUri,
      pendingClientId: f.attempt.retryClientId,
    },
    verifier,
    f.http,
  );
  const auth = new URL(fresh.authorizationUrl);
  expect(auth.searchParams.get("client_id")).toBe("oaiapp_dummy");
  expect(auth.searchParams.has("agent_name_hint")).toBe(false);
  expect(auth.searchParams.get("state")).not.toBe(f.state);
  expect(f.http).toHaveBeenCalledTimes(1);
});
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...pair.publicKey.export({ format: "jwk" }),
  kid: "dummy-key",
  alg: "RS256",
  use: "sig",
};
const claims = {
  iss: SIWC_ISSUER,
  aud: "oaiapp_dummy",
  exp: Math.floor(Date.now() / 1000) + 3600,
  nonce: "dummy-nonce",
  sub: "dummy-subject",
};
function jwt(value: unknown, alg = "RS256") {
  const head = Buffer.from(JSON.stringify({ alg, kid: "dummy-key" })).toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), pair.privateKey).toString("base64url")}`;
}
const jwksHttp = () =>
  vi.fn<typeof fetch>(async (url) =>
    String(url).includes("openid-configuration")
      ? json({
          issuer: SIWC_ISSUER,
          jwks_uri: `${SIWC_ISSUER}/.well-known/jwks.json`,
        })
      : json({ keys: [jwk] }),
  );
it("verifies actual RSA signatures with issuer/audience/nonce/expiry, not just decoded JWT", async () => {
  const http = jwksHttp(),
    verifyId = openaiIdVerifier(http),
    expected = { clientId: "oaiapp_dummy", nonce: "dummy-nonce" };
  expect(
    await verifyId(jwt(claims), expected, new AbortController().signal),
  ).toEqual({ subject: "dummy-subject" });
  for (const c of [
    { ...claims, iss: "https://other.invalid" },
    { ...claims, aud: "another" },
    { ...claims, nonce: "other" },
    { ...claims, exp: 1 },
    { ...claims, sub: "" },
    { ...claims, nbf: claims.exp },
  ])
    await expect(
      verifyId(jwt(c), expected, new AbortController().signal),
    ).rejects.toThrow("malformed");
  const tampered = jwt(claims).split(".");
  tampered[1] = Buffer.from(
    JSON.stringify({ ...claims, sub: "forged" }),
  ).toString("base64url");
  await expect(
    verifyId(tampered.join("."), expected, new AbortController().signal),
  ).rejects.toThrow("malformed");
  await expect(
    verifyId(jwt(claims, "none"), expected, new AbortController().signal),
  ).rejects.toThrow("malformed");
});
it("does not follow discovery to an external JWKS origin", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    json({ issuer: SIWC_ISSUER, jwks_uri: "https://other.invalid/key" }),
  );
  await expect(
    openaiIdVerifier(http)(
      jwt(claims),
      { clientId: "oaiapp_dummy", nonce: "dummy-nonce" },
      new AbortController().signal,
    ),
  ).rejects.toThrow("malformed");
  expect(http).toHaveBeenCalledTimes(1);
});
