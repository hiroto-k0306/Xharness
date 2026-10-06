import { randomUUID } from "node:crypto";
import type { ConnectionView, SiwcAction } from "../../shared/connections.js";
import { BoundaryError } from "./contracts.js";
import { SiwcVault, type VaultData } from "./siwc-vault.js";
import { listenSiwcCallback } from "./siwc-callback.js";
import {
  openaiIdVerifier,
  type IdVerifier,
  type SiwcGrant,
} from "./siwc-auth.js";
import { siwcHttpBinding, listSiwcModels } from "./siwc-http.js";
import { refreshSiwc, revokeSiwc, SiwcRefreshFailure } from "./siwc-refresh.js";
import type { Http } from "./siwc-http-utils.js";
import { abortable } from "./siwc-http-utils.js";
import type { SiwcBinding } from "./openai.js";
const plan = (g?: SiwcGrant) =>
  !!g &&
  ["resource.invoke", "chatgpt.tokens.use.direct"].every((s) =>
    g.scopes.includes(s),
  );

/** Main-only account lifecycle. Projection contains local handles, never OAuth URLs or identity. */
export class SiwcManager {
  #data?: VaultData;
  #busy = false;
  #message =
    "登録・独立したChatGPT plan認可が必要です。保存済み接続の確認またはContinue with ChatGPTを選択してください。";
  #models: { slug: string; displayName: string }[] = [];
  #revision = 0;
  #requests = new AbortController();
  #refresh?: Promise<SiwcGrant>;
  #refreshKey?: string;
  #retryAfter = 0;
  #pending?: AbortController;
  #pendingDone?: Promise<void>;
  #blocked = new Set<string>();
  constructor(
    private vault: SiwcVault,
    private openBrowser: (url: string) => Promise<void>,
    private options: {
      http?: Http;
      verifier?: IdVerifier;
      timeoutMs?: number;
      listen?: typeof listenSiwcCallback;
      simulated?: boolean;
      rememberSecrets?: (values: string[]) => void;
    } = {},
  ) {}
  #account(key = this.#data?.selected) {
    return this.#data?.accounts.find((a) => a.key === key);
  }
  #invalidate() {
    this.#revision++;
    this.#requests.abort();
    this.#requests = new AbortController();
    this.#models = [];
    this.#retryAfter = 0;
  }
  view(): ConnectionView {
    const account = this.#account(),
      grant = account?.grant;
    const available =
      !account?.refreshBlocked &&
      !this.#blocked.has(account?.key ?? "") &&
      plan(grant) &&
      (grant!.expiresAt > Date.now() ||
        (!!grant!.refreshToken &&
          (grant!.earliestRefreshAt ?? 0) <= Date.now()));
    return {
      mode: "openai-siwc",
      label: "OpenAI SIWC",
      status: available
        ? "available"
        : this.#data
          ? "needs_auth"
          : "unconfigured",
      reason: this.#message,
      siwc: {
        accounts: (this.#data?.accounts ?? []).map((a) => ({
          key: a.key,
          label: a.label,
          signedIn: !!a.grant,
          planEnabled: plan(a.grant),
        })),
        selected: this.#data?.selected,
        busy: this.#busy,
        welcome: !!account?.grant && plan(account.grant) && !account.welcomed,
        models: structuredClone(this.#models),
      },
    };
  }
  async #reload() {
    this.#data = await this.vault.read();
    this.options.rememberSecrets?.(
      [
        this.#data.hostId,
        ...this.#data.accounts.flatMap((a) => [
          a.clientId,
          a.subject,
          ...(a.grant
            ? [a.grant.accessToken, a.grant.idToken, a.grant.refreshToken ?? ""]
            : []),
        ]),
      ].filter(Boolean),
    );
  }
  cancel() {
    this.#pending?.abort();
  }
  async command(
    action: SiwcAction,
    key: string | undefined,
    signal: AbortSignal,
  ) {
    if (this.#busy) throw new BoundaryError("duplicate");
    this.#busy = true;
    let finish!: () => void;
    this.#pendingDone = new Promise<void>((r) => {
      finish = r;
    });
    const abort = new AbortController();
    this.#pending = abort;
    const inner = AbortSignal.any([signal, abort.signal]);
    try {
      await this.#reload();
      inner.throwIfAborted();
      if (action === "load") {
        this.#message = "保護保存された接続を確認しました。";
        return;
      }
      const selected = key ? this.#account(key) : undefined;
      if (key && !selected) throw new BoundaryError("malformed");
      if (action === "connect") {
        const callback = await (this.options.listen ?? listenSiwcCallback)(
          {
            hostId: this.#data!.hostId,
            selected: selected
              ? {
                  clientId: selected.clientId,
                  subject: selected.subject,
                  idToken: selected.grant?.idToken,
                }
              : undefined,
            pendingClientId: selected ? undefined : this.#data!.pendingClientId,
            requestPlanConsent: !!selected?.grant && !plan(selected.grant),
            timeoutMs: this.options.timeoutMs,
            http: this.options.http,
            verifier: this.options.verifier,
          },
          inner,
        );
        try {
          inner.throwIfAborted();
          await abortable(this.openBrowser(callback.authorizationUrl), inner);
          const grant = await abortable(callback.result, inner);
          this.options.rememberSecrets?.(
            [
              grant.accessToken,
              grant.refreshToken ?? "",
              grant.idToken,
              grant.subject,
              grant.clientId,
            ].filter(Boolean),
          );
          inner.throwIfAborted();
          this.#invalidate();
          await this.vault.mutate((data) => {
            inner.throwIfAborted();
            let account = data.accounts.find(
              (a) =>
                a.clientId === grant.clientId && a.subject === grant.subject,
            );
            if (!account) {
              account = {
                key: randomUUID(),
                label: `ChatGPT account ${data.accounts.length + 1}`,
                clientId: grant.clientId,
                subject: grant.subject,
              };
              data.accounts.push(account);
            }
            account.grant = grant;
            account.refreshBlocked = undefined;
            data.selected = account.key;
            data.pendingClientId = undefined;
          });
          await this.#reload();
          if (this.#data?.selected) this.#blocked.delete(this.#data.selected);
          this.#message = plan(grant)
            ? "ChatGPT planを使用します。利用量・アプリの上限はChatGPT Settingsで管理できます。"
            : "本人確認は完了しましたがChatGPT plan使用は未許可です。追加認可してから送信してください。";
        } catch (e) {
          if (callback.retryClientId() && !selected)
            await this.vault.mutate((d) => {
              d.pendingClientId = callback.retryClientId();
            });
          throw e;
        } finally {
          callback.cancel();
        }
      } else if (action === "select") {
        if (!selected) throw new BoundaryError("malformed");
        this.#invalidate();
        await this.vault.mutate((d) => {
          d.selected = selected.key;
        });
        await this.#reload();
        this.#message = plan(selected.grant)
          ? `${selected.label} — ChatGPT planを使用します。`
          : "選択した接続は再認可が必要です。";
      } else if (action === "signout") {
        const account = selected ?? this.#account();
        if (!account) throw new BoundaryError("malformed");
        this.#blocked.add(account.key);
        this.#invalidate(); // Stop refresh and in-flight inference before touching the session.
        await this.#refresh?.catch(() => {});
        await this.vault.mutate((d) => {
          const a = d.accounts.find((a) => a.key === account.key)!;
          a.refreshBlocked = true;
          if (d.selected === a.key) d.selected = undefined;
        });
        await this.#reload();
        const current = (await this.vault.read()).accounts.find(
          (a) => a.key === account.key,
        );
        const revoked = current?.grant
          ? await revokeSiwc(current.grant, inner, this.options.http)
          : true;
        await this.vault.mutate((d) => {
          const a = d.accounts.find((a) => a.key === account.key)!;
          a.grant = undefined;
          a.refreshBlocked = undefined;
          if (d.selected === a.key) d.selected = undefined;
        });
        await this.#reload();
        this.#message = revoked
          ? "サインアウトしました。登録とhost IDは保持します。"
          : "ローカルからサインアウトしました。サーバー側の解除は未確認です。ChatGPT Settingsで接続を解除してください。";
      } else if (action === "acknowledge") {
        const account = this.#account();
        if (!account) throw new BoundaryError("unconfigured");
        await this.vault.mutate((d) => {
          d.accounts.find((a) => a.key === account.key)!.welcomed = true;
        });
        await this.#reload();
      } else if (action === "catalog") {
        const account = this.#account();
        if (!account) throw new BoundaryError("unconfigured");
        const grant = await this.#grant(account.key, inner);
        const models = await listSiwcModels(grant, inner, this.options.http);
        inner.throwIfAborted();
        const secrets = [
          grant.accessToken,
          grant.refreshToken,
          grant.idToken,
          grant.subject,
          grant.clientId,
          grant.hostId,
        ].filter((v): v is string => !!v);
        const clean = (s: string) =>
          secrets.reduce((v, secret) => v.replaceAll(secret, "[redacted]"), s);
        this.#models = models
          .filter((m) => /^[A-Za-z0-9_.-]{1,100}$/.test(m.slug))
          .filter((m) => clean(m.slug) === m.slug)
          .map((m) => ({
            slug: m.slug,
            displayName: clean(m.displayName).slice(0, 160),
          }));
        this.#message = "選択したアカウントで利用可能なモデルを取得しました。";
      }
    } catch (e) {
      this.#message = inner.aborted
        ? "接続操作をキャンセルしました。"
        : "接続操作を完了できませんでした。保護保存・認可状態を確認してください。";
      throw e instanceof BoundaryError
        ? e
        : new BoundaryError(inner.aborted ? "cancelled" : "transport");
    } finally {
      this.#busy = false;
      this.#pending = undefined;
      finish();
      this.#pendingDone = undefined;
    }
  }
  async #grant(key: string, signal: AbortSignal): Promise<SiwcGrant> {
    const account = this.#account(key),
      grant = account?.grant;
    if (!grant || !plan(grant)) throw new BoundaryError("unconfigured");
    if (this.#refresh) {
      if (this.#refreshKey !== key) throw new BoundaryError("duplicate");
      return this.#refresh;
    }
    if (account?.refreshBlocked || this.#blocked.has(key))
      throw new BoundaryError("uncertain");
    if (
      grant.expiresAt > Date.now() + 60000 ||
      (grant.expiresAt > Date.now() &&
        (grant.earliestRefreshAt ?? 0) > Date.now())
    )
      return structuredClone(grant);
    if (Date.now() < this.#retryAfter) throw new BoundaryError("transport");
    const revision = this.#revision;
    const inner = AbortSignal.any([signal, this.#requests.signal]);
    this.#refreshKey = key;
    this.#refresh = (async () => {
      try {
        this.#blocked.add(key);
        // Persist an intent before rotating. A crash/lost response requires explicit reauthorization.
        await this.vault.mutate((d) => {
          d.accounts.find((a) => a.key === key)!.refreshBlocked = true;
        });
        await this.#reload();
        inner.throwIfAborted();
        const replacement = await refreshSiwc(
          grant,
          inner,
          this.options.http,
          this.options.verifier ?? openaiIdVerifier(this.options.http),
        );
        this.options.rememberSecrets?.(
          [
            replacement.accessToken,
            replacement.refreshToken ?? "",
            replacement.idToken,
            replacement.subject,
            replacement.clientId,
          ].filter(Boolean),
        );
        inner.throwIfAborted();
        if (revision !== this.#revision) throw new BoundaryError("cancelled");
        await this.vault.mutate((d) => {
          inner.throwIfAborted();
          if (revision !== this.#revision) throw new BoundaryError("cancelled");
          const a = d.accounts.find((a) => a.key === key)!;
          a.grant = replacement;
          a.refreshBlocked = undefined;
        });
        await this.#reload();
        this.#blocked.delete(key);
        return replacement;
      } catch (e) {
        if (
          e instanceof SiwcRefreshFailure &&
          e.terminal &&
          revision === this.#revision
        ) {
          await this.vault.mutate((d) => {
            const a = d.accounts.find((a) => a.key === key)!;
            a.grant = undefined;
            a.refreshBlocked = undefined;
          });
          await this.#reload();
          this.#message =
            "更新用資格情報が失効しました。同じ登録で再認可してください。";
        } else {
          this.#retryAfter = Date.now() + 30000;
        }
        throw e;
      } finally {
        this.#refresh = undefined;
        this.#refreshKey = undefined;
      }
    })();
    return this.#refresh;
  }
  binding(): SiwcBinding | undefined {
    const account = this.#account();
    if (
      !account?.grant ||
      !plan(account.grant) ||
      account.refreshBlocked ||
      this.#blocked.has(account.key)
    )
      return undefined;
    const key = account.key,
      revision = this.#revision;
    return {
      registrationConfirmed: true,
      grantSource: "registered-client",
      send: (request, signal) => this.#send(key, revision, request, signal),
    };
  }
  async *#send(
    key: string,
    revision: number,
    request: Parameters<SiwcBinding["send"]>[0],
    signal: AbortSignal,
  ) {
    if (revision !== this.#revision) throw new BoundaryError("cancelled");
    if (!this.#models.some((m) => m.slug === request.body.model))
      throw new BoundaryError("unsupported");
    const inner = AbortSignal.any([signal, this.#requests.signal]);
    const grant = await this.#grant(key, inner);
    inner.throwIfAborted();
    if (revision !== this.#revision) throw new BoundaryError("cancelled");
    yield* siwcHttpBinding(grant, this.options.http).send(request, inner);
  }
  async close() {
    this.cancel();
    this.#invalidate();
    await this.#pendingDone;
    await this.#refresh?.catch(() => {});
    await this.vault.close();
  }
}
