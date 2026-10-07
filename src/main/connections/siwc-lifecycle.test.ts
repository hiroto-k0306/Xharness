import { it, expect, vi } from "vitest";
import {
  randomUUID,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { SiwcVault, type VaultBackend } from "./siwc-vault.js";
import { SiwcManager } from "./siwc-manager.js";
import { refreshSiwc, revokeSiwc } from "./siwc-refresh.js";
import { SIWC_ISSUER } from "./siwc-http-utils.js";
import type { SiwcGrant, IdVerifier } from "./siwc-auth.js";
import type { SiwcProtector } from "./siwc-store.js";
import type { listenSiwcCallback } from "./siwc-callback.js";

const signal = () => new AbortController().signal;
const verify: IdVerifier = async () => ({ subject: "dummy-subject" });
function grant(hostId: string = randomUUID()): SiwcGrant {
  const now = Date.now();
  return {
    issuer: SIWC_ISSUER,
    hostId,
    clientId: "oaiapp_dummy",
    subject: "dummy-subject",
    accessToken: "dummy-access",
    refreshToken: "dummy-refresh",
    idToken: "dummy-id",
    scopes: [
      "openid",
      "offline_access",
      "resource.invoke",
      "chatgpt.tokens.use.direct",
    ],
    savedAt: now - 1000,
    expiresAt: now + 3600000,
  };
}
function storage() {
  const bytes = new Map<string, Buffer>();
  let leased = false,
    fail = false;
  const backend: VaultBackend = {
    async acquire() {
      if (leased) throw new Error("busy");
      leased = true;
      return async () => {
        leased = false;
      };
    },
    async read(k) {
      return bytes.get(k);
    },
    async replaceAtomic(k, v) {
      if (fail) throw new Error("dummy-secret");
      bytes.set(k, Buffer.from(v));
    },
    async remove(k) {
      bytes.delete(k);
    },
  };
  const secret = randomBytes(32);
  const protector: SiwcProtector = {
    available: () => true,
    encrypt(v) {
      const iv = randomBytes(12),
        c = createCipheriv("aes-256-gcm", secret, iv);
      return Buffer.concat([iv, c.update(v), c.final(), c.getAuthTag()]);
    },
    decrypt(v) {
      const d = createDecipheriv("aes-256-gcm", secret, v.subarray(0, 12));
      d.setAuthTag(v.subarray(-16));
      return Buffer.concat([
        d.update(v.subarray(12, -16)),
        d.final(),
      ]).toString();
    },
  };
  return {
    backend,
    protector,
    bytes,
    setFail() {
      fail = true;
    },
  };
}
const tokens = {
  access_token: "dummy-next-access",
  refresh_token: "dummy-next-refresh",
  id_token: "dummy-next-id",
  scope: "openid offline_access resource.invoke chatgpt.tokens.use.direct",
  token_type: "Bearer",
  expires_in: 3600,
};
function httpFixture(refresh = async () => Response.json(tokens)) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) return refresh();
    if (url.endsWith("/models"))
      return Response.json({
        models: [
          { slug: "gpt-5.4", display_name: "dummy-access", visibility: "list" },
        ],
      });
    if (url.endsWith("/openid-configuration"))
      return Response.json({
        issuer: SIWC_ISSUER,
        revocation_endpoint: `${SIWC_ISSUER}/revoke`,
      });
    if (url.endsWith("/revoke")) return new Response(null, { status: 200 });
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init?.headers as Record<string, string>).Authorization).toMatch(
      /^Bearer dummy-/,
    );
    return new Response(
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":1}}}\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  });
}
async function fixture(http = httpFixture()) {
  const s = storage(),
    vault = new SiwcVault(s.backend, s.protector);
  const host = (await vault.read()).hostId,
    g = grant(host),
    key = randomUUID();
  await vault.mutate((d) => {
    d.accounts = [
      {
        key,
        label: "ChatGPT account 1",
        clientId: g.clientId,
        subject: g.subject,
        grant: g,
      },
    ];
    d.selected = key;
  });
  const manager = new SiwcManager(vault, async () => {}, {
    http,
    verifier: verify,
  });
  await manager.command("load", undefined, signal());
  await manager.command("catalog", undefined, signal());
  return { s, vault, manager, http, key, g };
}
async function consume(
  binding: NonNullable<ReturnType<SiwcManager["binding"]>>,
  s = signal(),
) {
  const events = [];
  for await (const e of binding.send(
    {
      endpoint: "https://api.openai.com/v1/responses",
      body: { model: "gpt-5.4", store: false, stream: true },
    },
    s,
  ))
    events.push(e);
  return events;
}
it("encrypts host/account mapping, preserves host after signout/reopen and refuses another lease", async () => {
  const f = await fixture(),
    host = (await f.vault.read()).hostId;
  await expect(
    new SiwcVault(f.s.backend, f.s.protector).init(),
  ).rejects.toThrow("busy");
  for (const b of f.s.bytes.values())
    for (const v of [host, "dummy-subject", "dummy-access", "oaiapp_dummy"])
      expect(b.toString()).not.toContain(v);
  await f.manager.command("signout", f.key, signal());
  expect((await f.vault.read()).accounts[0]).toMatchObject({
    clientId: "oaiapp_dummy",
    grant: undefined,
  });
  await f.manager.close();
  const reopened = new SiwcVault(f.s.backend, f.s.protector);
  expect((await reopened.read()).hostId).toBe(host);
  await reopened.close();
});
it("never falls back to plaintext or overwrites unreadable state", async () => {
  const s = storage();
  const unavailable = { ...s.protector, available: () => false };
  await expect(new SiwcVault(s.backend, unavailable).init()).rejects.toThrow(
    "unconfigured",
  );
  expect(s.bytes.size).toBe(0);
  s.bytes.set("0".repeat(64), Buffer.from("unreadable"));
  await expect(new SiwcVault(s.backend, s.protector).init()).rejects.toThrow(
    "unconfigured",
  );
  expect(s.bytes.values().next().value?.toString()).toBe("unreadable");
});
it("storage failure fences refresh/signout and never dispatches inference or exposes secrets", async () => {
  const f = await fixture();
  await f.vault.mutate((d) => {
    d.accounts[0]!.grant!.expiresAt = Date.now() + 30000;
  });
  await f.manager.command("load", undefined, signal());
  const bytes = [...f.s.bytes.values()][0]!.toString("hex");
  f.s.setFail();
  await expect(consume(f.manager.binding()!)).rejects.toThrow("transport");
  expect(f.manager.binding()).toBeUndefined();
  expect(
    f.http.mock.calls.some(
      ([u]) =>
        String(u).endsWith("/oauth/token") || String(u).endsWith("/responses"),
    ),
  ).toBe(false);
  await expect(f.manager.command("signout", f.key, signal())).rejects.toThrow(
    "transport",
  );
  expect(f.manager.binding()).toBeUndefined();
  expect([...f.s.bytes.values()][0]!.toString("hex")).toBe(bytes);
  await f.manager.close();
});
it("serializes concurrent refresh, uses one replacement and saves before inference", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const http = httpFixture(async () => {
    await gate;
    return Response.json(tokens);
  });
  const f = await fixture(http);
  await f.vault.mutate((d) => {
    d.accounts[0]!.grant!.expiresAt = Date.now() + 30000;
  });
  await f.manager.command("load", undefined, signal());
  const binding = f.manager.binding()!,
    a = consume(binding),
    b = consume(binding);
  await vi.waitFor(() =>
    expect(
      http.mock.calls.filter(([u]) => String(u).endsWith("/oauth/token")),
    ).toHaveLength(1),
  );
  expect((await f.vault.read()).accounts[0]?.refreshBlocked).toBe(true);
  finish();
  await Promise.all([a, b]);
  const stored = (await f.vault.read()).accounts[0]!;
  expect(stored.grant?.refreshToken).toBe(tokens.refresh_token);
  expect(stored.refreshBlocked).toBeUndefined();
  const req = http.mock.calls.find(([u]) =>
    String(u).endsWith("/oauth/token"),
  )![1]!;
  const body = req.body as URLSearchParams;
  expect(body.get("client_id")).toBe("oaiapp_dummy");
  expect(body.has("scope")).toBe(false);
  await f.manager.close();
});
it.each([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
])(
  "clears only unusable token set on %s and keeps registration",
  async (code) => {
    const f = await fixture(
      httpFixture(async () =>
        Response.json(
          { error: code, error_description: "dummy-secret" },
          { status: 400 },
        ),
      ),
    );
    await f.vault.mutate((d) => {
      d.accounts[0]!.grant!.expiresAt = Date.now() + 30000;
    });
    await f.manager.command("load", undefined, signal());
    await expect(consume(f.manager.binding()!)).rejects.toThrow("denied");
    expect((await f.vault.read()).accounts[0]).toMatchObject({
      clientId: "oaiapp_dummy",
      grant: undefined,
    });
    expect(JSON.stringify(f.manager.view())).not.toContain("dummy-secret");
    await f.manager.close();
  },
);
it("preserves credentials but fences ambiguous refresh across restart; no automatic retry", async () => {
  const http = httpFixture(async () => {
    throw new Error("dummy-access");
  });
  const f = await fixture(http);
  await f.vault.mutate((d) => {
    d.accounts[0]!.grant!.expiresAt = Date.now() + 30000;
  });
  await f.manager.command("load", undefined, signal());
  await expect(consume(f.manager.binding()!)).rejects.toThrow("transport");
  expect(f.manager.binding()).toBeUndefined();
  const stored = (await f.vault.read()).accounts[0]!;
  expect(stored.grant?.refreshToken).toBe("dummy-refresh");
  expect(stored.refreshBlocked).toBe(true);
  await f.manager.close();
  const vault = new SiwcVault(f.s.backend, f.s.protector),
    m = new SiwcManager(vault, async () => {}, { http });
  await m.command("load", undefined, signal());
  expect(m.binding()).toBeUndefined();
  expect(
    http.mock.calls.filter(([u]) => String(u).endsWith("/oauth/token")),
  ).toHaveLength(1);
  await m.close();
});
it("cancels late refresh during signout and never resurrects tokens", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((r) => {
    finish = r;
  });
  const f = await fixture(
    httpFixture(async () => {
      await gate;
      return Response.json(tokens);
    }),
  );
  await f.vault.mutate((d) => {
    d.accounts[0]!.grant!.expiresAt = Date.now() + 30000;
  });
  await f.manager.command("load", undefined, signal());
  const sent = consume(f.manager.binding()!);
  void sent.catch(() => {});
  await vi.waitFor(() =>
    expect(
      f.http.mock.calls.some(([u]) => String(u).endsWith("/oauth/token")),
    ).toBe(true),
  );
  await f.manager.command("signout", f.key, signal());
  finish();
  await expect(sent).rejects.toThrow("cancelled");
  expect((await f.vault.read()).accounts[0]?.grant).toBeUndefined();
  await f.manager.close();
});
it("rejects wrong refresh identity, missing replacement and early refresh without leaking", async () => {
  const g = grant();
  g.earliestRefreshAt = Date.now() + 100000;
  const http = vi.fn<typeof fetch>(async () => Response.json(tokens));
  await expect(refreshSiwc(g, signal(), http, verify)).rejects.toThrow(
    "unconfigured",
  );
  expect(http).not.toHaveBeenCalled();
  delete g.earliestRefreshAt;
  await expect(
    refreshSiwc(g, signal(), http, async () => ({ subject: "other" })),
  ).rejects.toThrow("denied");
  await expect(
    refreshSiwc(
      g,
      signal(),
      async () => Response.json({ ...tokens, refresh_token: undefined }),
      verify,
    ),
  ).rejects.toThrow("transport");
});
it("does not follow external revocation endpoints and reports remote failure", async () => {
  const http = vi.fn<typeof fetch>(async () =>
    Response.json({
      issuer: SIWC_ISSUER,
      revocation_endpoint: "https://other.invalid/revoke",
    }),
  );
  expect(await revokeSiwc(grant(), signal(), http)).toBe(false);
  expect(http).toHaveBeenCalledTimes(1);
});
it("keeps pending sign-in separate, consumes cancel and preserves plan-disabled identity", async () => {
  const s = storage(),
    vault = new SiwcVault(s.backend, s.protector);
  let finish!: (g: SiwcGrant) => void;
  let attempts = 0;
  const listen: typeof listenSiwcCallback = async () => ({
    authorizationUrl: `${SIWC_ISSUER}/api/accounts/authorize`,
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    result: new Promise((r) => {
      attempts++;
      finish = r;
    }),
    cancel() {},
    retryClientId: () => undefined,
  });
  // Use an uncooperative callback fixture to exercise manager's own cancellation fence.
  const m = new SiwcManager(vault, async () => {}, { listen });
  const controller = new AbortController();
  const pending = m.command("connect", undefined, controller.signal);
  void pending.catch(() => {});
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(m.binding()).toBeUndefined();
  controller.abort();
  const g = grant((await vault.read()).hostId);
  finish(g);
  await expect(pending).rejects.toThrow("cancelled");
  expect((await vault.read()).accounts).toHaveLength(0);
  const next = m.command("connect", undefined, signal());
  await vi.waitFor(() => expect(attempts).toBe(2));
  g.scopes = ["openid"];
  finish(g);
  await next;
  expect(m.binding()).toBeUndefined();
  expect(m.view().siwc?.accounts[0]?.planEnabled).toBe(false);
  expect(JSON.stringify(m.view())).not.toMatch(
    /dummy-(access|subject)|oaiapp_dummy/,
  );
  await m.close();
});
