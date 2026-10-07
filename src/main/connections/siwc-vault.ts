import { randomUUID } from "node:crypto";
import type { SiwcGrant } from "./siwc-auth.js";
import { BoundaryError } from "./contracts.js";
import {
  validSiwcGrant,
  type ProtectedBlobs,
  type SiwcProtector,
} from "./siwc-store.js";

export interface SiwcAccount {
  key: string; // Local opaque handle; never the provider's subject or client ID.
  label: string;
  clientId: string;
  subject: string;
  grant?: SiwcGrant;
  welcomed?: boolean;
  refreshBlocked?: boolean;
}
export interface VaultData {
  version: 1;
  hostId: string;
  accounts: SiwcAccount[];
  selected?: string;
  pendingClientId?: string;
}
export interface VaultBackend extends ProtectedBlobs {
  /** Lifetime exclusive lease: no second process can race rotating credentials. */
  acquire(): Promise<() => Promise<void>>;
}
const fileKey = "0".repeat(64);
function valid(v: VaultData) {
  return (
    v?.version === 1 &&
    typeof v.hostId === "string" &&
    /^[a-f0-9-]{36}$/.test(v.hostId) &&
    Array.isArray(v.accounts) &&
    v.accounts.length <= 100 &&
    v.accounts.every(
      (a) =>
        typeof a.key === "string" &&
        /^[a-f0-9-]{36}$/.test(a.key) &&
        typeof a.label === "string" &&
        /^ChatGPT account [1-9][0-9]*$/.test(a.label) &&
        typeof a.clientId === "string" &&
        /^[a-zA-Z0-9_-]{1,200}$/.test(a.clientId) &&
        a.clientId !== "dynamic_agent_client" &&
        typeof a.subject === "string" &&
        !!a.subject &&
        a.subject.length <= 100000 &&
        (a.grant === undefined ||
          (validSiwcGrant(a.grant) &&
            a.grant.clientId === a.clientId &&
            a.grant.subject === a.subject &&
            a.grant.hostId === v.hostId)),
    ) &&
    new Set(v.accounts.map((a) => a.key)).size === v.accounts.length &&
    new Set(v.accounts.map((a) => JSON.stringify([a.clientId, a.subject])))
      .size === v.accounts.length &&
    (v.selected === undefined ||
      v.accounts.some((a) => a.key === v.selected)) &&
    (v.pendingClientId === undefined ||
      (/^[a-zA-Z0-9_-]{1,200}$/.test(v.pendingClientId) &&
        v.pendingClientId !== "dynamic_agent_client"))
  );
}
/** All identity, mappings and tokens live in one encrypted transaction; no plaintext index. */
export class SiwcVault {
  #data?: VaultData;
  #init?: Promise<void>;
  #release?: () => Promise<void>;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(
    private backend: VaultBackend,
    private protector: SiwcProtector,
  ) {}
  init() {
    if (this.#closed) return Promise.reject(new BoundaryError("unconfigured"));
    return (this.#init ??= this.#load());
  }
  async #load() {
    if (!this.protector.available()) throw new BoundaryError("unconfigured");
    this.#release = await this.backend.acquire();
    try {
      const encrypted = await this.backend.read(fileKey);
      const data = encrypted
        ? (JSON.parse(this.protector.decrypt(encrypted)) as VaultData)
        : { version: 1 as const, hostId: randomUUID(), accounts: [] };
      if (!valid(data)) throw new BoundaryError("malformed");
      if (!encrypted) await this.#save(data);
      this.#data = data;
    } catch {
      await this.#release();
      this.#release = undefined;
      throw new BoundaryError("unconfigured"); // Never overwrite unreadable vaults.
    }
  }
  async #save(data: VaultData) {
    if (!this.protector.available() || !valid(data))
      throw new BoundaryError("unconfigured");
    try {
      const encrypted = this.protector.encrypt(JSON.stringify(data));
      if (!encrypted.length) throw new Error();
      await this.backend.replaceAtomic(fileKey, encrypted);
    } catch {
      throw new BoundaryError("transport");
    }
  }
  async read() {
    await this.init();
    await this.#tail;
    return structuredClone(this.#data!);
  }
  mutate(work: (data: VaultData) => void) {
    const next = this.#tail.then(async () => {
      await this.init();
      const draft = structuredClone(this.#data!);
      work(draft);
      await this.#save(draft);
      this.#data = draft;
    });
    this.#tail = next.catch(() => {});
    return next;
  }
  async close() {
    await this.#tail;
    this.#closed = true;
    await this.#release?.();
    this.#release = undefined;
    this.#data = undefined;
  }
}
