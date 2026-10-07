import { createHash } from "node:crypto";
import { BoundaryError } from "./contracts.js";
import { SIWC_ISSUER } from "./siwc-http.js";
import type { SiwcGrant } from "./siwc-auth.js";

/** Main-process OS-user-bound protection (e.g. Windows DPAPI), never basic-text fallback. */
export interface SiwcProtector {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(encrypted: Buffer): string;
}
/** Backend contract: owner-only location, atomic durable replacement, no secret diagnostics.
 * This stage supplies the interface, not an installed-app credential destination/ACL migration.
 */
export interface ProtectedBlobs {
  read(key: string): Promise<Buffer | undefined>;
  replaceAtomic(key: string, encrypted: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
}
function key(clientId: string, subject: string) {
  return createHash("sha256")
    .update(JSON.stringify([clientId, subject]))
    .digest("hex");
}
export function validSiwcGrant(value: unknown): value is SiwcGrant {
  if (!value || typeof value !== "object") return false;
  const v = value as SiwcGrant;
  return (
    v.issuer === SIWC_ISSUER &&
    typeof v.clientId === "string" &&
    !!v.clientId &&
    v.clientId !== "dynamic_agent_client" &&
    typeof v.subject === "string" &&
    !!v.subject &&
    typeof v.hostId === "string" &&
    !!v.hostId &&
    typeof v.accessToken === "string" &&
    !!v.accessToken &&
    typeof v.idToken === "string" &&
    !!v.idToken &&
    (v.refreshToken === undefined || typeof v.refreshToken === "string") &&
    Array.isArray(v.scopes) &&
    v.scopes.every((s) => typeof s === "string") &&
    Number.isSafeInteger(v.expiresAt) &&
    Number.isSafeInteger(v.savedAt) &&
    v.expiresAt > v.savedAt &&
    (v.earliestRefreshAt === undefined ||
      Number.isSafeInteger(v.earliestRefreshAt))
  );
}
/** No I/O or credential access on construction. Full account/tokens record encrypted together. */
export function protectedSiwcStore(
  blobs: ProtectedBlobs,
  protector: SiwcProtector,
) {
  let tail: Promise<void> = Promise.resolve();
  const mutate = (work: () => Promise<void>) => {
    const next = tail.then(work);
    tail = next.catch(() => {});
    return next;
  };
  return {
    async get(
      clientId: string,
      subject: string,
    ): Promise<SiwcGrant | undefined> {
      await tail;
      if (!protector.available()) throw new BoundaryError("unconfigured");
      try {
        const encrypted = await blobs.read(key(clientId, subject));
        if (!encrypted) return undefined;
        const value: unknown = JSON.parse(protector.decrypt(encrypted));
        if (
          !validSiwcGrant(value) ||
          value.clientId !== clientId ||
          value.subject !== subject
        )
          return undefined;
        return value;
      } catch {
        // Keep unreadable records; never copy CLI credentials or overwrite with partial state.
        return undefined;
      }
    },
    save(value: SiwcGrant) {
      value = structuredClone(value);
      return mutate(async () => {
        if (!protector.available() || !validSiwcGrant(value))
          throw new BoundaryError("unconfigured");
        try {
          const encrypted = protector.encrypt(JSON.stringify(value));
          if (!encrypted.length) throw new BoundaryError("unconfigured");
          await blobs.replaceAtomic(
            key(value.clientId, value.subject),
            encrypted,
          );
        } catch {
          throw new BoundaryError("transport");
        }
      });
    },
    delete(clientId: string, subject: string) {
      return mutate(async () => {
        try {
          await blobs.remove(key(clientId, subject));
        } catch {
          throw new BoundaryError("transport");
        }
      });
    },
  };
}
