import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { JsonFile } from "./store.js";
import { type QuotaPauseView } from "../../shared/quota-resume.js";

export interface QuotaPause extends QuotaPauseView {
  sessionId: string;
  createdAt: number;
  approvedAt?: number;
  observed: {
    receivedAt: number;
    retryAfterSec?: number;
    scope?: string;
    windows?: import("../providers/provider.js").QuotaUsage["windows"];
  };
  snapshot: {
    taskId?: string;
    originalTask: { userMessageIndex: number };
    phase: string;
    unfinished: string[];
    effort: string;
    premiseHash?: string;
    messagesHash: string;
    messageCount: number;
    checkpointHash: string;
    conditionsHash: string;
    cwd: string;
    workspaceId: string | null;
    readOnly: boolean;
    permissionMode?: string;
    results: string[];
    approval: "current-policy-only";
  };
}
const STATES = [
  "paused",
  "waiting",
  "running",
  "manual",
  "cancelled",
  "expired",
  "completed",
];
const valid = (rows: unknown): rows is QuotaPause[] =>
  Array.isArray(rows) &&
  rows.length <= 100 &&
  rows.every(
    (row) =>
      row &&
      typeof row.id === "string" &&
      typeof row.sessionId === "string" &&
      /^[\w-]{1,128}$/.test(row.sessionId) &&
      STATES.includes(row.state) &&
      typeof row.reason === "string" &&
      typeof row.provider === "string" &&
      typeof row.model === "string" &&
      typeof row.scope === "string" &&
      typeof row.eligible === "boolean" &&
      Number.isFinite(row.expiresAt) &&
      Number.isFinite(row.createdAt) &&
      Number.isSafeInteger(row.attempts) &&
      (row.nextCheckAt === undefined || Number.isFinite(row.nextCheckAt)) &&
      row.snapshot &&
      typeof row.snapshot.messagesHash === "string" &&
      typeof row.snapshot.conditionsHash === "string" &&
      typeof row.snapshot.checkpointHash === "string" &&
      Number.isSafeInteger(row.snapshot.messageCount),
  );

/** One writer owns this store. Claim is persisted BEFORE invoking any continuation. */
export class QuotaPauses {
  private rows: QuotaPause[] = [];
  private readonly file: JsonFile<QuotaPause[]>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly leases = new Map<string, AbortController>();
  constructor(
    private readonly host: {
      home: string;
      now(): number;
      changed(): Promise<void>;
      busy(sessionId: string): boolean;
      resume(
        pause: QuotaPause,
        signal: AbortSignal,
      ): Promise<string | undefined>;
      timers?: boolean;
    },
  ) {
    this.file = new JsonFile(join(host.home, "quota-pauses.json"), valid);
  }
  get(sessionId: string) {
    return this.rows.find((row) => row.sessionId === sessionId);
  }
  get warnings() {
    return this.file.warnings;
  }
  view(sessionId: string): QuotaPauseView | undefined {
    const row = this.get(sessionId);
    if (!row) return undefined;
    const {
      id,
      state,
      reason,
      provider,
      model,
      scope,
      nextCheckAt,
      expiresAt,
      eligible,
      attempts,
    } = row;
    return {
      id,
      state,
      reason,
      provider,
      model,
      scope,
      nextCheckAt,
      expiresAt,
      eligible,
      attempts,
      taskId: row.snapshot.taskId,
      phase: row.snapshot.phase,
    };
  }
  async load() {
    this.rows = await this.file.read([]);
    for (const row of this.rows)
      if (row.state === "running") {
        row.state = "manual";
        row.reason = "前回の自動再開結果が未確定です。自動再送しません。";
        row.eligible = false;
      }
    await this.file.write(this.rows);
    this.arm();
  }
  async put(
    value: Omit<
      QuotaPause,
      "id" | "state" | "attempts" | "createdAt" | "expiresAt"
    >,
  ) {
    if (this.stopped) return;
    const previous = this.get(value.sessionId);
    const continuing =
      previous?.state === "running" &&
      previous.snapshot.taskId === value.snapshot.taskId;
    const now = this.host.now();
    const row: QuotaPause = {
      ...value,
      id: randomUUID(),
      createdAt: continuing ? previous.createdAt : now,
      expiresAt: continuing ? previous.expiresAt : now + 14 * 86400000,
      attempts: continuing ? previous.attempts : 0,
      approvedAt: continuing ? previous.approvedAt : undefined,
      state:
        value.eligible && value.nextCheckAt !== undefined
          ? continuing
            ? "waiting"
            : "paused"
          : "manual",
    };
    if (row.attempts >= 3) {
      row.state = "manual";
      row.eligible = false;
      row.reason = "自動再開3回の上限です。手動で確認してください。";
    }
    this.rows = this.rows.filter((r) => r.sessionId !== row.sessionId);
    if (this.rows.length >= 100)
      this.rows = this.rows.filter((r) =>
        ["waiting", "running", "paused", "manual"].includes(r.state),
      );
    if (this.rows.length >= 100) throw new Error("Quota pause limit");
    this.rows.push(row);
    await this.persist();
  }
  private async persist() {
    await this.file.write(this.rows);
    await this.host.changed();
    this.arm();
  }
  async action(sessionId: string, action: "enable" | "cancel" | "now") {
    const row = this.get(sessionId);
    if (!row) return "枠待ちの記録がありません。";
    if (action === "cancel") {
      this.leases.get(row.id)?.abort();
      row.state = "cancelled";
      row.eligible = false;
      row.reason = "ユーザー操作により自動再開を取り消しました。";
      await this.persist();
      return undefined;
    }
    if (!row.eligible || !["paused", "manual", "waiting"].includes(row.state))
      return "この状態は自動復元できません。新しい指示で内容を確認してください。";
    if (action === "enable" && row.nextCheckAt === undefined)
      return "回復時刻が不明です。手動で再確認してください。";
    if (row.expiresAt <= this.host.now()) return "再開記録は期限切れです。";
    row.state = "waiting";
    row.approvedAt = this.host.now();
    if (action === "now") row.nextCheckAt = this.host.now();
    row.reason =
      action === "now"
        ? "ユーザーが手動再確認を要求しました。"
        : "明示許可済み。回復予定時刻後に条件を再確認します。";
    await this.persist();
    return undefined;
  }
  async cancel(sessionId: string, reason: string) {
    const row = this.get(sessionId);
    if (!row || ["cancelled", "expired", "completed"].includes(row.state))
      return;
    this.leases.get(row.id)?.abort();
    row.state = "cancelled";
    row.eligible = false;
    row.reason = reason;
    await this.persist();
  }
  private arm() {
    if (
      this.stopped ||
      this.host.timers === false ||
      this.timer ||
      !this.rows.some((r) => ["waiting", "paused", "manual"].includes(r.state))
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick()
        .catch(() => undefined)
        .finally(() => this.arm());
    }, 1000);
    this.timer.unref?.();
  }
  async tick() {
    for (const row of [...this.rows]) {
      if (
        this.stopped ||
        this.get(row.sessionId)?.id !== row.id ||
        !["waiting", "paused", "manual"].includes(row.state)
      )
        continue;
      if (row.expiresAt <= this.host.now()) {
        row.state = "expired";
        row.eligible = false;
        row.reason = "14日の再開期限が切れました。";
        await this.persist();
        continue;
      }
      if (
        row.state !== "waiting" ||
        row.nextCheckAt === undefined ||
        row.nextCheckAt > this.host.now() ||
        this.host.busy(row.sessionId)
      )
        continue;
      const peers = this.rows.filter(
        (peer) =>
          peer.id !== row.id &&
          peer.provider === row.provider &&
          ["paused", "waiting", "manual", "running"].includes(peer.state),
      );
      if (peers.some((peer) => peer.state === "running")) continue;
      if (peers.some((peer) => peer.nextCheckAt === undefined)) {
        row.state = "manual";
        row.reason =
          "同providerの別の枠待ちは回復時刻が不明です。手動で確認してください。";
        await this.persist();
        continue;
      }
      const later = Math.max(
        row.nextCheckAt,
        ...peers.map((peer) => peer.nextCheckAt!),
      );
      if (later > this.host.now()) {
        row.nextCheckAt = later;
        await this.persist();
        continue;
      }
      // No await between checking and claiming. Parallel ticks see running.
      row.state = "running";
      row.attempts++;
      const lease = new AbortController();
      this.leases.set(row.id, lease);
      const expiry = setTimeout(
        () => lease.abort(),
        Math.max(0, row.expiresAt - this.host.now()),
      );
      expiry.unref?.();
      try {
        await this.persist();
        if (
          lease.signal.aborted ||
          this.stopped ||
          this.get(row.sessionId)?.state !== "running"
        )
          continue;
        const reason = await this.host.resume(
          structuredClone(row),
          lease.signal,
        );
        const latest = this.get(row.sessionId);
        if (latest?.id === row.id && latest.state === "running") {
          const expired = latest.expiresAt <= this.host.now();
          latest.state = expired ? "expired" : reason ? "manual" : "completed";
          latest.eligible = false;
          latest.reason = expired
            ? "再開期限が切れたため中断しました。"
            : (reason ?? "安全な会話境界から続行しました。");
          await this.persist();
        }
      } catch {
        if (this.get(row.sessionId)?.id === row.id && row.state === "running") {
          row.state = "manual";
          row.eligible = false;
          row.reason =
            "再開の保存・条件・実行を確認できません。自動再送しません。";
          await this.persist().catch(() => undefined);
        }
      } finally {
        clearTimeout(expiry);
        this.leases.delete(row.id);
      }
    }
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const lease of this.leases.values()) lease.abort();
    for (const row of this.rows)
      if (row.state === "running") {
        row.state = "manual";
        row.eligible = false;
        row.reason = "再開中にアプリを終了しました。結果を確認してください。";
      }
    await this.file.write(this.rows);
  }
}
