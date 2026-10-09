import { randomUUID } from "node:crypto";
import { type CommandResult } from "../../shared/ipc.js";

type Trigger =
  | { kind: "time"; due: number; interval: number; remaining: number }
  | { kind: "idle" | "event"; label?: string; ready: boolean };
interface Job {
  id: string;
  sessionId: string;
  text: string;
  expires: number;
  trigger: Trigger;
  abort: AbortController;
}
/** Volatile user-created jobs only. Constructing this registry never sends work. */
export class SessionSchedules {
  private jobs = new Map<string, Job>();
  private launching = new Map<string, Job>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(
    private readonly host: {
      now(): number;
      busy(sessionId: string): boolean;
      send(
        sessionId: string,
        text: string,
        signal: AbortSignal,
      ): Promise<CommandResult>;
      notice(sessionId: string, text: string): void;
    },
  ) {}
  command(sessionId: string, command: string): CommandResult {
    if (this.stopped) return { ok: false, error: "予約機能は終了しています。" };
    const [name, action, ...args] = command.trim().split(/\s+/);
    const fail = (): CommandResult => ({
      ok: false,
      error:
        "予約の指定を確認してください。/schedule help で書式を確認できます。",
    });
    if (name === "/signal") {
      if (!action || args.length || !/^[\w-]{1,64}$/.test(action))
        return fail();
      for (const j of this.jobs.values())
        if (
          j.sessionId === sessionId &&
          j.trigger.kind === "event" &&
          j.trigger.label === action
        )
          j.trigger.ready = true;
      this.arm();
      this.host.notice(
        sessionId,
        "イベントを通知しました（この会話の既存の待機だけが対象です）。",
      );
      return { ok: true };
    }
    if (!action || action === "help") {
      this.host.notice(
        sessionId,
        "/schedule after <秒:1〜604800> <指示>\n/schedule every <秒:60〜604800> <回数:1〜20> <指示>\n/schedule idle <指示>（次の正常終了後1回）\n/schedule event <名前> <指示>（/signal <名前>で1回）\n/schedule list\n/schedule cancel <ID|all>\n予約はこの起動中だけ有効。停止・会話を閉じる・アプリ終了で取消。指示は通常のモデル通信・権限・通信上限に従います。",
      );
      return { ok: true };
    }
    if (action === "list") {
      if (args.length) return fail();
      this.host.notice(
        sessionId,
        JSON.stringify(
          [...this.jobs.values()]
            .filter((j) => j.sessionId === sessionId)
            .map((j) => ({
              id: j.id,
              text: j.text,
              expires: j.expires,
              trigger: j.trigger,
            })),
        ),
      );
      return { ok: true };
    }
    if (action === "cancel") {
      if (args.length !== 1) return fail();
      if (args[0] === "all") this.cancel(sessionId);
      else {
        const j = this.jobs.get(args[0]!) ?? this.launching.get(args[0]!);
        if (!j || j.sessionId !== sessionId) return fail();
        j.abort.abort();
        this.jobs.delete(j.id);
        this.launching.delete(j.id);
      }
      this.host.notice(
        sessionId,
        "予約を取り消しました。開始済みの実行は停止ボタンで中断できます。",
      );
      return { ok: true };
    }
    const now = this.host.now();
    let trigger: Trigger;
    if (action === "after" || action === "every") {
      const seconds = Number(args.shift());
      const count = action === "every" ? Number(args.shift()) : 1;
      if (
        !Number.isSafeInteger(seconds) ||
        seconds < (action === "every" ? 60 : 1) ||
        seconds > 604800 ||
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > 20
      )
        return fail();
      trigger = {
        kind: "time",
        due: now + seconds * 1000,
        interval: action === "every" ? seconds * 1000 : 0,
        remaining: count,
      };
    } else if (action === "idle") trigger = { kind: "idle", ready: false };
    else if (action === "event") {
      const label = args.shift();
      if (!label || !/^[\w-]{1,64}$/.test(label)) return fail();
      trigger = { kind: "event", label, ready: false };
    } else return fail();
    const text = args.join(" ");
    if (!text.trim() || text.length > 4000 || text.startsWith("/"))
      return fail();
    const active = [...this.jobs.values(), ...this.launching.values()];
    if (
      active.length >= 20 ||
      active.filter((j) => j.sessionId === sessionId).length >= 5
    )
      return { ok: false, error: "予約の上限です（会話5件・アプリ20件）。" };
    const id = randomUUID().slice(0, 8);
    this.jobs.set(id, {
      id,
      sessionId,
      text,
      trigger,
      expires: now + 604800000,
      abort: new AbortController(),
    });
    this.host.notice(
      sessionId,
      `予約 ${id} を登録しました。起動中だけ有効で、発火時には通常のモデル通信が発生します。`,
    );
    this.arm();
    return { ok: true };
  }
  idle(sessionId: string) {
    for (const j of this.jobs.values())
      if (j.sessionId === sessionId && j.trigger.kind === "idle")
        j.trigger.ready = true;
    this.arm();
  }
  cancel(sessionId: string) {
    for (const map of [this.jobs, this.launching])
      for (const j of map.values())
        if (j.sessionId === sessionId) {
          j.abort.abort();
          map.delete(j.id);
        }
    if (!this.jobs.size) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
  close() {
    this.stopped = true;
    for (const j of [...this.jobs.values(), ...this.launching.values()])
      j.abort.abort();
    this.jobs.clear();
    this.launching.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private arm() {
    if (this.stopped || this.timer || !this.jobs.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick()
        .catch(() => undefined)
        .finally(() => this.arm());
    }, 1000);
    this.timer.unref?.();
  }
  async tick() {
    const now = this.host.now();
    for (const j of [...this.jobs.values()]) {
      if (!this.jobs.has(j.id) || this.stopped) continue;
      if (j.expires < now) {
        this.jobs.delete(j.id);
        this.host.notice(
          j.sessionId,
          `予約 ${j.id} は7日の期限で終了しました。`,
        );
        continue;
      }
      const ready =
        j.trigger.kind === "time" ? j.trigger.due <= now : j.trigger.ready;
      if (
        !ready ||
        this.host.busy(j.sessionId) ||
        [...this.launching.values()].some((k) => k.sessionId === j.sessionId)
      )
        continue;
      // Claim before await. Concurrent timer/event ticks cannot launch this job twice.
      this.jobs.delete(j.id);
      this.launching.set(j.id, j);
      let result: CommandResult;
      try {
        result = await this.host.send(j.sessionId, j.text, j.abort.signal);
      } catch {
        result = { ok: false, error: "予約の実行に失敗しました。" };
      } finally {
        this.launching.delete(j.id);
      }
      if (j.abort.signal.aborted || this.stopped) continue;
      if (!result.ok) {
        this.host.notice(
          j.sessionId,
          `予約 ${j.id} は送信を開始できなかったため終了しました。再登録してください。`,
        );
        continue;
      }
      if (j.trigger.kind === "time" && --j.trigger.remaining > 0) {
        j.trigger.due = this.host.now() + j.trigger.interval;
        this.jobs.set(j.id, j);
      } else
        this.host.notice(j.sessionId, `予約 ${j.id} の指示を送信しました。`);
    }
  }
}
