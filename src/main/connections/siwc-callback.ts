import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SiwcAttempt, type IdVerifier, type SiwcGrant } from "./siwc-auth.js";
import type { Http } from "./siwc-http.js";
import { BoundaryError } from "./contracts.js";

/** Explicit caller only; does not open the browser or persist/activate an account. */
export async function listenSiwcCallback(
  options: {
    hostId: string;
    selected?: { clientId: string; subject: string; idToken?: string };
    requestPlanConsent?: boolean;
    pendingClientId?: string;
    timeoutMs?: number;
    verifier?: IdVerifier;
    http?: Http;
  },
  signal: AbortSignal,
) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)
    throw new BoundaryError("malformed");
  signal.throwIfAborted();
  let attempt: SiwcAttempt | undefined;
  let settled = false;
  let accepted = false;
  let resolve!: (grant: SiwcGrant) => void;
  let reject!: (error: BoundaryError) => void;
  const result = new Promise<SiwcGrant>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Caller may attach after bind; prevent a transient unhandled rejection on immediate cancel.
  void result.catch(() => {});
  const active = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (
    grant?: SiwcGrant,
    error = new BoundaryError("cancelled"),
  ) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    attempt?.discard();
    active.abort();
    server.close();
    server.closeAllConnections();
    if (grant) resolve(grant);
    else reject(error);
  };
  const cancel = () => finish();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (!attempt || settled || !request.url?.startsWith("/auth/callback?")) {
      response.writeHead(404).end("Not found");
      return;
    }
    const expected = new URL(attempt.redirectUri);
    if (
      request.method !== "GET" ||
      request.headers.host !== expected.host ||
      request.url.length > 16384
    ) {
      response.writeHead(400).end("Sign-in rejected");
      finish(undefined, new BoundaryError("malformed"));
      return;
    }
    // Stop duplicate callbacks immediately; retain only this in-memory exchange.
    if (accepted) {
      response.writeHead(409).end("Sign-in already received");
      return;
    }
    accepted = true;
    server.close();
    response.writeHead(200).end("Return to XHarness to check sign-in status.");
    void attempt
      .finish(new URL(request.url, expected.origin).href, active.signal)
      .then(
        (grant) => finish(grant),
        (error) =>
          finish(
            undefined,
            error instanceof BoundaryError
              ? error
              : new BoundaryError("transport"),
          ),
      );
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", no);
        yes();
      });
    });
    const port = (server.address() as AddressInfo).port;
    attempt = new SiwcAttempt(
      {
        hostId: options.hostId,
        selected: options.selected,
        requestPlanConsent: options.requestPlanConsent,
        pendingClientId: options.pendingClientId,
        timeoutMs,
        redirectUri: `http://127.0.0.1:${port}/auth/callback`,
      },
      options.verifier,
      options.http,
    );
    server.on("error", () => finish(undefined, new BoundaryError("transport")));
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(
      () => finish(undefined, new BoundaryError("timeout")),
      timeoutMs,
    );
    if (signal.aborted) cancel();
    return {
      authorizationUrl: attempt.authorizationUrl,
      redirectUri: attempt.redirectUri,
      result,
      cancel,
      retryClientId: () => attempt?.retryClientId,
    };
  } catch {
    finish(undefined, new BoundaryError("transport"));
    throw new BoundaryError("transport");
  }
}
