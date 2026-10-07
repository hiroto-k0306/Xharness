import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { listenSiwcCallback } from "./siwc-callback.js";
import {
  protectedSiwcStore,
  type ProtectedBlobs,
  type SiwcProtector,
} from "./siwc-store.js";
import type { SiwcGrant } from "./siwc-auth.js";
const grant: SiwcGrant = {
  issuer: "https://auth.openai.com",
  clientId: "oaiapp_dummy",
  subject: "dummy-subject",
  hostId: "dummy-host",
  idToken: "dummy-id-token",
  accessToken: "dummy-access-token",
  refreshToken: "dummy-refresh-token",
  scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
  savedAt: Date.now(),
  expiresAt: Date.now() + 3600000,
};
const verifier = async () => ({ subject: grant.subject });
const http = () =>
  vi.fn<typeof fetch>(async () =>
    Response.json({
      access_token: grant.accessToken,
      id_token: grant.idToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: grant.scopes.join(" "),
    }),
  );
it("a duplicate callback cannot cancel the accepted exchange or dispatch it twice", async () => {
  let finish!: (r: Response) => void;
  const remote = vi.fn<typeof fetch>(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const l = await listenSiwcCallback(
    { hostId: "dummy-host", verifier, http: remote },
    new AbortController().signal,
  );
  const u = new URL(l.redirectUri);
  u.search = new URLSearchParams({
    state: new URL(l.authorizationUrl).searchParams.get("state")!,
    code: "dummy-code",
    client_id: "oaiapp_dummy",
  }).toString();
  const responses = await Promise.allSettled([fetch(u), fetch(u)]);
  expect(
    responses.some((r) => r.status === "fulfilled" && r.value.status === 200),
  ).toBe(true);
  await vi.waitFor(() => expect(remote).toHaveBeenCalledTimes(1));
  finish(
    Response.json({
      access_token: grant.accessToken,
      id_token: grant.idToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope: grant.scopes.join(" "),
    }),
  );
  expect((await l.result).subject).toBe(grant.subject);
  expect(remote).toHaveBeenCalledTimes(1);
});
it("binds loopback before URL generation and returns a verified grant without saving/activating", async () => {
  const remote = http(),
    abort = new AbortController();
  const listener = await listenSiwcCallback(
    { hostId: "dummy-host", verifier, http: remote },
    abort.signal,
  );
  const auth = new URL(listener.authorizationUrl);
  expect(auth.searchParams.get("redirect_uri")).toBe(listener.redirectUri);
  const url = new URL(listener.redirectUri);
  url.search = new URLSearchParams({
    state: auth.searchParams.get("state")!,
    code: "dummy-code",
    client_id: "oaiapp_dummy",
  }).toString();
  const response = await fetch(url);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.text()).not.toContain("dummy-code");
  expect((await listener.result).clientId).toBe("oaiapp_dummy");
  expect(remote).toHaveBeenCalledTimes(1);
});
it("denial, wrong state, cancellation and timeout dispose listener without token exchange", async () => {
  for (const kind of ["denied", "state", "post", "cancel", "timeout"]) {
    const remote = http(),
      abort = new AbortController();
    const l = await listenSiwcCallback(
      {
        hostId: "dummy-host",
        verifier,
        http: remote,
        timeoutMs: kind === "timeout" ? 20 : 1000,
      },
      abort.signal,
    );
    const result = l.result.catch((e) => e as Error);
    if (kind === "cancel") abort.abort();
    else if (kind !== "timeout") {
      const u = new URL(l.redirectUri),
        state = new URL(l.authorizationUrl).searchParams.get("state")!;
      u.search = new URLSearchParams({
        state: kind === "state" ? "wrong" : state,
        error: "access_denied",
      }).toString();
      const response = await fetch(
        u,
        kind === "post" ? { method: "POST" } : {},
      );
      if (kind === "post") expect(response.status).toBe(400);
    }
    expect(await result).toBeInstanceOf(Error);
    expect(remote).not.toHaveBeenCalled();
    await expect(fetch(l.redirectUri)).rejects.toThrow();
  }
});
function fixtureStore() {
  const map = new Map<string, Buffer>(),
    secret = randomBytes(32);
  const blobs: ProtectedBlobs = {
    read: async (k) => map.get(k),
    replaceAtomic: vi.fn(async (k, v) => {
      map.set(k, v);
    }),
    remove: async (k) => {
      map.delete(k);
    },
  };
  const protector: SiwcProtector = {
    available: () => true,
    encrypt: (plain) => {
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", secret, iv);
      const bytes = Buffer.concat([
        cipher.update(plain, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decrypt: (bytes) => {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        secret,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
  };
  return { map, blobs, protector, store: protectedSiwcStore(blobs, protector) };
}
it("encrypts identity/tokens together, separates account/client pairs, atomically replaces grants", async () => {
  const f = fixtureStore();
  expect(f.map.size).toBe(0);
  await f.store.save(grant);
  await f.store.save({ ...grant, clientId: "other_client" });
  expect(f.map.size).toBe(2);
  for (const [key, bytes] of f.map) {
    expect(key).not.toContain(grant.subject);
    expect(bytes.toString()).not.toContain(grant.accessToken);
    expect(bytes.toString()).not.toContain(grant.subject);
  }
  expect(await f.store.get(grant.clientId, grant.subject)).toEqual(grant);
  expect(await f.store.get(grant.clientId, "other_subject")).toBeUndefined();
  await f.store.save({
    ...grant,
    accessToken: "dummy-replaced",
    refreshToken: "dummy-rotated",
    scopes: ["resource.invoke"],
    expiresAt: grant.expiresAt + 1000,
  });
  expect(await f.store.get(grant.clientId, grant.subject)).toMatchObject({
    accessToken: "dummy-replaced",
    refreshToken: "dummy-rotated",
    scopes: ["resource.invoke"],
    expiresAt: grant.expiresAt + 1000,
  });
  await f.store.delete(grant.clientId, grant.subject);
  expect(await f.store.get(grant.clientId, grant.subject)).toBeUndefined();
});
it("does not save plaintext when protection is unavailable; unreadable/failed writes preserve old record", async () => {
  const f = fixtureStore();
  await f.store.save(grant);
  vi.mocked(f.blobs.replaceAtomic).mockRejectedValueOnce(
    new Error("dummy-access-token"),
  );
  await expect(
    f.store.save({ ...grant, accessToken: "dummy-new" }),
  ).rejects.toThrow("transport");
  expect((await f.store.get(grant.clientId, grant.subject))?.accessToken).toBe(
    grant.accessToken,
  );
  f.protector.available = () => false;
  await expect(f.store.save(grant)).rejects.toThrow("unconfigured");
  expect(f.map.size).toBe(1);
  f.protector.available = () => true;
  f.protector.decrypt = () => {
    throw new Error("dummy-id-token");
  };
  expect(await f.store.get(grant.clientId, grant.subject)).toBeUndefined();
  expect(f.map.size).toBe(1);
});
