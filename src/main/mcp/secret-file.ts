// 暗号化した値をファイルに保存する SecretStore(DESIGN.md §25.7)。暗号化そのものは呼び出し側が渡す
// (アプリでは Electron の safeStorage = Windows の DPAPI)。electron を import しない。
import { join } from "node:path";
import { JsonFile } from "../session/store.js";
import { type SecretStore } from "./oauth.js";

export interface Cipher {
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

type Stored = Record<string, string>;

export function fileSecretStore(dir: string, cipher: Cipher): SecretStore {
  const file = new JsonFile<Stored>(
    join(dir, "mcp-oauth.json"),
    (v): v is Stored =>
      !!v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      Object.values(v).every((x) => typeof x === "string"),
  );
  return {
    async get(key) {
      const value = (await file.read({}))[key];
      if (!value) return undefined;
      try {
        return cipher.decrypt(Buffer.from(value, "base64"));
      } catch {
        // 別のユーザー・別の端末で暗号化された値は読めない。無いものとして扱い、認可し直す
        return undefined;
      }
    },
    async set(key, value) {
      const all = await file.read({});
      all[key] = cipher.encrypt(value).toString("base64");
      await file.write(all);
    },
    async delete(key) {
      const all = await file.read({});
      delete all[key];
      await file.write(all);
    },
  };
}
