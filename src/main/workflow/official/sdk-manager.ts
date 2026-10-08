import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  rm,
  realpath,
  lstat,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { SdkRuntimeView } from "../../../shared/sdk-runtime.js";
import {
  SDK_NAME,
  SDK_BASELINE,
  compatibleSdk,
  nativePackage,
  registryPackage,
  downloadPackage,
} from "./sdk-package.js";
import {
  bundledSdkDirectory,
  packageJson,
  seedSdk,
  validateSdkTree,
} from "./sdk-install.js";
import { probeManagedSdk } from "./sdk-worker-client.js";

const DAY = 24 * 60 * 60 * 1000;
type Active = { directory: string; version: string };
/** Immutable installations; switching a pointer never changes an already-created agent. */
export class ClaudeSdkManager {
  private active?: Active;
  private entry?: string;
  private status: SdkRuntimeView = {
    state: "preparing",
    message: "Claude SDKを準備しています。",
  };
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private shutdown = new AbortController();
  readonly root: string;
  constructor(
    root: string,
    private ports: {
      source?: () => Promise<string>;
      seed?: typeof seedSdk;
      validate?: typeof validateSdkTree;
      probe?: typeof probeManagedSdk;
      download?: typeof downloadPackage;
      fetch?: typeof fetch;
      now?: () => number;
    } = {},
  ) {
    this.root = resolve(root);
  }
  view(): SdkRuntimeView {
    return { ...this.status, root: this.root };
  }
  selectedEntry() {
    if (!this.entry)
      throw new Error(
        "Claude SDKを準備できません。接続設定のSDK状態を確認してください。",
      );
    return this.entry;
  }
  async start() {
    await this.prepare();
    // Do not block UI on update downloads. No SDK query/auth operation is made here.
    void this.check();
    this.timer = setInterval(() => void this.check(), 60 * 60 * 1000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    this.shutdown.abort();
    clearInterval(this.timer);
    await this.pending;
  }
  private async safeRoot() {
    await mkdir(this.root, { recursive: true });
    if ((await realpath(this.root)).toLowerCase() !== this.root.toLowerCase())
      throw new Error("sdk-root-linked");
  }
  private async json(name: string, value: unknown) {
    const temporary = join(this.root, `${name}.${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(value), { flag: "wx" });
    await rename(temporary, join(this.root, name));
  }
  private async read(name: string) {
    const path = join(this.root, name),
      stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 4096
    )
      throw new Error("sdk-state-invalid");
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  }
  private async adopt(active: Active) {
    if (
      !/^v0\.3\.\d+-[a-f0-9-]{36}$/.test(active.directory) ||
      !/^0\.3\.\d+$/.test(active.version) ||
      Number(active.version.split(".")[2]) < 290 ||
      !active.directory.startsWith(`v${active.version}-`)
    )
      throw new Error("sdk-pointer-invalid");
    const entry = await (this.ports.validate ?? validateSdkTree)(
      join(this.root, active.directory),
      active.version,
    );
    await (this.ports.probe ?? probeManagedSdk)(entry);
    this.entry = entry;
    this.active = active;
    this.status = {
      ...this.status,
      version: active.version,
      state: "ready",
      message: "Claude SDKは準備済みです。更新は次のタスクから反映します。",
    };
  }
  private async locked(work: () => Promise<void>) {
    await this.safeRoot();
    const path = join(this.root, "update.lock");
    const lock = await open(path, "wx");
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await work();
    } finally {
      await lock.close();
      await rm(path);
    }
  }
  private attention(code: string) {
    this.status = { ...this.status, state: "attention", message: code };
  }
  private async prepare() {
    try {
      await this.safeRoot();
      const existing = await this.readActive();
      if (existing) {
        await this.adopt(existing);
        return;
      }
      await this.locked(async () => {
        // A second instance may have finished seeding before we acquired the lock.
        const activeNow = await this.readActive();
        if (activeNow) {
          await this.adopt(activeNow);
          return;
        }
        const source = await (this.ports.source ?? bundledSdkDirectory)();
        const baseline = await packageJson(source);
        if (baseline.version !== SDK_BASELINE)
          throw new Error("sdk-baseline-changed");
        const active = {
          directory: `v${baseline.version}-${randomUUID()}`,
          version: baseline.version,
        };
        await (this.ports.seed ?? seedSdk)(
          join(this.root, active.directory),
          source,
        );
        await this.adopt(active);
        await this.json("active.json", active);
      });
    } catch {
      this.entry = undefined;
      this.attention(
        "Claude SDKの管理領域を準備できません。ファイル・更新ロック・対応版を確認してください。別のSDKへは切り替えていません。",
      );
    }
  }
  private async readActive(): Promise<Active | undefined> {
    try {
      return (await this.read("active.json")) as Active;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private network: typeof fetch = (input, init) =>
    (this.ports.fetch ?? fetch)(input, {
      ...init,
      signal: AbortSignal.any([
        this.shutdown.signal,
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  check(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closed || !this.entry) return Promise.resolve();
    this.pending = this.checkOnce().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async checkOnce() {
    try {
      await this.locked(async () => {
        const now = (this.ports.now ?? Date.now)();
        let last = 0;
        try {
          const state = await this.read("check.json");
          if (
            typeof state.at !== "number" ||
            !Number.isFinite(state.at) ||
            state.at < 0
          )
            throw new Error("sdk-check-invalid");
          last = state.at;
          this.status.checkedAt = new Date(last).toISOString();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (last && now - last < DAY) return;
        await this.json("check.json", { at: now }); // Reserve even failed attempts across restarts.
        this.status = {
          ...this.status,
          state: "checking",
          checkedAt: new Date(now).toISOString(),
          message: "Claude SDKの更新を確認しています。",
        };
        const candidate = await registryPackage(
          SDK_NAME,
          "latest",
          this.network,
        );
        this.status.candidate = candidate.version;
        const baseline = await packageJson(
          await (this.ports.source ?? bundledSdkDirectory)(),
        );
        if (!compatibleSdk(candidate, baseline)) {
          this.attention(
            "新しいClaude SDKは互換範囲外です。現在の版を維持します。XHarnessの対応更新が必要です。",
          );
          return;
        }
        if (
          Number(candidate.version.split(".")[2]) <=
          Number(this.active!.version.split(".")[2])
        ) {
          this.status = {
            ...this.status,
            state: "ready",
            message: "Claude SDKの更新を確認しました。対応範囲の最新版です。",
          };
          return;
        }
        const active = {
          directory: `v${candidate.version}-${randomUUID()}`,
          version: candidate.version,
        };
        const directory = join(this.root, active.directory);
        // Carry the verified peer dependency closure forward; replace SDK/native as a pair.
        await (this.ports.seed ?? seedSdk)(
          directory,
          await (this.ports.source ?? bundledSdkDirectory)(),
        );
        for (const name of [SDK_NAME, nativePackage()]) {
          const target = resolve(directory, "node_modules", name);
          if (
            !target.startsWith(`${resolve(directory)}\\`) &&
            !target.startsWith(`${resolve(directory)}/`)
          )
            throw new Error("sdk-install-target-rejected");
          // Keep dependencies nested under the SDK for distinct peer contexts.
          // This directory is a fresh private candidate, never the active tree.
          for (const file of await readdir(target)) {
            if (file === "node_modules") continue;
            const child = resolve(target, file);
            if (
              !child.startsWith(`${target}\\`) &&
              !child.startsWith(`${target}/`)
            )
              throw new Error("sdk-install-target-rejected");
            await rm(child, { recursive: true, force: true });
          }
          await (this.ports.download ?? downloadPackage)(
            name === SDK_NAME
              ? candidate
              : await registryPackage(name, candidate.version, this.network),
            target,
            this.network,
          );
        }
        const entry = await (this.ports.validate ?? validateSdkTree)(
          directory,
          candidate.version,
        );
        await (this.ports.probe ?? probeManagedSdk)(entry);
        this.shutdown.signal.throwIfAborted();
        await this.json("active.json", active);
        this.active = active;
        this.entry = entry;
        this.status = {
          ...this.status,
          version: active.version,
          state: "ready",
          message:
            "Claude SDKを更新しました。次のタスクから使用します。実行中のタスクは元の版を使います。",
        };
      });
    } catch {
      this.attention(
        "Claude SDKの更新を完了できませんでした。通信・整合性・互換性・更新ロックを確認してください。現在の版を維持し、24時間以内は再通信しません。",
      );
    }
  }
}
