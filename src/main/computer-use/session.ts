import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { JsonFile } from "../session/store.js";
import {
  projectHistoryAccess,
  type HistoryScope,
} from "../tools/project-history.js";
import {
  LOCAL_FIXTURE_URL,
  type BrowserObservation,
  type BrowserOperation,
  type LocalBrowserAction,
  type LocalBrowserView,
} from "../../shared/local-browser.js";
import { type Receipt } from "../../shared/ipc.js";
import {
  type BrowserFrame,
  type LocalBrowserAdapter,
  type LocalBrowserFactory,
} from "./adapter.js";

export class LocalBrowserFault extends Error {}
interface Journal {
  sessionCreatedAt: number;
  project: string;
  cwd: string;
  operations: BrowserOperation[];
}
const valid = (v: unknown): v is Journal => {
  if (!v || typeof v !== "object") return false;
  const j = v as Journal;
  return (
    Number.isFinite(j.sessionCreatedAt) &&
    typeof j.project === "string" &&
    typeof j.cwd === "string" &&
    Array.isArray(j.operations) &&
    j.operations.length <= 100 &&
    Buffer.byteLength(JSON.stringify(v), "utf8") <= 256_000 &&
    new Set(j.operations.map((o) => o.id)).size === j.operations.length &&
    j.operations.every(
      (o) =>
        [o.id, o.observationId, o.tabId, o.documentId].every(
          (s) => typeof s === "string" && /^[\w-]{1,128}$/.test(s),
        ) &&
        Number.isSafeInteger(o.generation) &&
        o.generation > 0 &&
        o.url === LOCAL_FIXTURE_URL &&
        [o.frameHash, o.imageHash].every(
          (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s),
        ) &&
        ["fake", "electron_local"].includes(o.mode) &&
        ["pending", "succeeded", "cancelled", "unknown"].includes(o.status) &&
        Number.isFinite(o.startedAt) &&
        (o.finishedAt === undefined || Number.isFinite(o.finishedAt)) &&
        (o.countAfter === undefined ||
          (Number.isSafeInteger(o.countAfter) && o.countAfter >= 0)) &&
        o.target?.id === "increment" &&
        typeof o.target.label === "string" &&
        o.target.label.length <= 80 &&
        [o.target.x, o.target.y, o.target.width, o.target.height].every(
          Number.isFinite,
        ),
    )
  );
};
interface State {
  phase: LocalBrowserView["phase"];
  generation: number;
  adapter?: LocalBrowserAdapter;
  observation?: BrowserObservation;
  confirmation?: { id: string; expiresAt: number };
  abort?: AbortController;
  operations: BrowserOperation[];
  busy: boolean;
  note: string;
}
export class LocalBrowserSessions {
  private states = new Map<string, State>();
  constructor(
    private readonly factory?: LocalBrowserFactory,
    private readonly now = Date.now,
    private readonly timeoutMs = 5000,
  ) {}
  private state(id: string) {
    let s = this.states.get(id);
    if (!s) {
      s = {
        phase: "stopped",
        generation: 0,
        operations: [],
        busy: false,
        note: "内蔵ローカルfixtureだけを観測できます。画像・ページ内命令は未信頼です。",
      };
      this.states.set(id, s);
    }
    return s;
  }
  private view(s: State): LocalBrowserView {
    return structuredClone({
      phase: s.phase,
      available: !!this.factory,
      mode: s.adapter?.mode ?? s.operations.at(-1)?.mode,
      observation: ["observed", "awaiting_confirmation", "executing"].includes(
        s.phase,
      )
        ? s.observation
        : undefined,
      confirmation: s.confirmation,
      operations: s.operations,
      note: s.note,
    });
  }
  async stop(id: string) {
    const s = this.state(id);
    s.abort?.abort();
    s.confirmation = undefined;
    s.observation = undefined;
    const adapter = s.adapter;
    if (s.phase === "executing") {
      s.phase = "unknown";
      s.note =
        "停止を要求しました。実行結果と保存の確定は一覧で確認してください。";
    } else if (s.phase !== "unknown") {
      s.phase = "stopped";
      s.note = "停止しました。古い観測・確認票は使えません。";
    }
    if (adapter)
      await this.limited(adapter.close(), new AbortController().signal);
    if (s.adapter === adapter) s.adapter = undefined;
    return this.view(s);
  }
  async stopAll() {
    await Promise.all([...this.states.keys()].map((id) => this.stop(id)));
  }
  private async journal(scope: HistoryScope) {
    const access = projectHistoryAccess(scope),
      pin = await access.pin,
      session = scope.sessions.get(scope.sessionId);
    if (!pin || !session || !(await access.eligible(session, true)))
      throw new LocalBrowserFault("project/session境界を確認してください。");
    const directory = join(pin.home, "local-browser");
    await mkdir(directory, { recursive: true });
    if ((await realpath(directory)) !== directory)
      throw new LocalBrowserFault("保存先の別名は使用できません。");
    const path = join(directory, `${session.id}.json`),
      file = new JsonFile<Journal>(path, valid);
    let data: Journal = {
      sessionCreatedAt: session.createdAt,
      project: pin.root,
      cwd: session.cwd,
      operations: [],
    };
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256_000)
        throw new Error("Invalid journal");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!valid(value)) throw new Error("Invalid journal");
      data = value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new LocalBrowserFault(
          "操作記録が不明です。自動復旧・再実行はしません。",
        );
    }
    if (
      data.sessionCreatedAt !== session.createdAt ||
      data.project !== pin.root ||
      data.cwd !== session.cwd
    )
      throw new LocalBrowserFault("操作記録のprojectが変更されています。");
    return { data, file };
  }
  private async limited<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined,
      cancel: () => void = () => {};
    try {
      return await Promise.race([
        job,
        new Promise<never>((_, reject) => {
          cancel = () => reject(new LocalBrowserFault("停止・取消しました。"));
          timer = setTimeout(
            () => reject(new LocalBrowserFault("タイムアウトしました。")),
            this.timeoutMs,
          );
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
  async run(
    scope: HistoryScope,
    action: LocalBrowserAction,
    authorize: (tool: string) => Promise<void>,
    record: (r: Receipt) => Promise<void>,
  ): Promise<LocalBrowserView> {
    if (action.action === "stop") {
      await this.stop(scope.sessionId);
      const s = this.state(scope.sessionId);
      if (!s.busy) {
        const { data } = await this.journal(scope);
        s.operations = data.operations.map((o) =>
          o.status === "pending" ? { ...o, status: "unknown" as const } : o,
        );
        if (s.operations.some((o) => o.status === "unknown")) {
          s.phase = "unknown";
          s.note =
            "未確定な操作があります。停止しても再実行は許可されません。receiptを確認してください。";
        }
      }
      await record({
        id: randomUUID(),
        sessionId: scope.sessionId,
        ts: this.now(),
        provider: "harness",
        kind: "tool",
        tool: "LocalBrowserStop",
        summary: "ローカル観測/操作に停止を要求",
        input: { operationId: s.operations.at(-1)?.id },
        output: s.note,
        decision: "deny",
        durationMs: 0,
      });
      return this.view(s);
    }
    const s = this.state(scope.sessionId);
    if (s.busy) throw new LocalBrowserFault("操作終了後に確認してください。");
    s.busy = true;
    const abort = new AbortController();
    s.abort = abort;
    let operation: BrowserOperation | undefined,
      invoked = false,
      intentAttempted = false;
    let journal:
      Awaited<ReturnType<LocalBrowserSessions["journal"]>> | undefined;
    const audit = (
      tool: string,
      id: string,
      summary: string,
      input: unknown,
      output: string,
      decision: Receipt["decision"] = "allow",
    ) =>
      record({
        id,
        sessionId: scope.sessionId,
        ts: this.now(),
        provider: "harness",
        kind: tool === "LocalBrowserConfirm" ? "permission" : "tool",
        tool,
        summary,
        input: structuredClone(input),
        output,
        decision,
        durationMs: 0,
      });
    try {
      journal = await this.journal(scope);
      s.operations = journal.data.operations.map((o) =>
        o.status === "pending" ? { ...o, status: "unknown" as const } : o,
      );
      journal.data.operations = s.operations;
      if (s.operations.some((o) => o.status === "unknown")) {
        s.phase = "unknown";
        s.note =
          "未確定な操作があります。再実行せずreceiptを確認し、新しい会話を使用してください。";
      }
      if (action.action === "view") return this.view(s);
      if (s.phase === "unknown") throw new LocalBrowserFault(s.note);
      if (!this.factory)
        throw new LocalBrowserFault(
          "この実行環境にはローカルブラウザadapterがありません。",
        );
      if (
        (await scope.sessions.evaluationTask(scope.sessionId))?.recoveryRequired
      )
        throw new LocalBrowserFault("会話の保存が未確定です。");
      if (action.action === "observe") {
        await authorize("LocalBrowserObserve");
        abort.signal.throwIfAborted();
        s.confirmation = undefined;
        s.adapter ??= this.factory();
        const frame = await this.limited(
          s.adapter.observe(abort.signal),
          abort.signal,
        );
        s.observation = {
          ...frame,
          id: randomUUID(),
          generation: ++s.generation,
        };
        await audit(
          "LocalBrowserObserve",
          s.observation.id,
          "ローカルfixtureを観測（未信頼・モデル未送信）",
          {
            ...s.observation,
            image: undefined,
            count: s.observation.count,
            mode: s.adapter.mode,
          },
          "観測のみ。権限付与・操作実行・テスト合格ではありません。",
        );
        abort.signal.throwIfAborted();
        s.phase = "observed";
        s.note = "観測済み。対象は固定ボタン1個。操作前に明示確認が必要です。";
        return this.view(s);
      }
      if (action.action === "confirm") {
        const old = s.operations.find((o) => o.id === action.confirmationId);
        if (old) return this.view(s); // Duplicate/lost reply: never invoke twice.
      }
      const observation = s.observation,
        adapter = s.adapter;
      if (!observation || !adapter)
        throw new LocalBrowserFault(
          "古い観測は使えません。再観測してください。",
        );
      if (action.action === "prepare") {
        if (s.phase !== "observed" || action.observationId !== observation.id)
          throw new LocalBrowserFault("観測の世代が変わっています。");
        await authorize("LocalBrowserClick");
        const fresh = await this.limited(
          adapter.observe(abort.signal),
          abort.signal,
        );
        if (
          fresh.frameHash !== observation.frameHash ||
          fresh.tabId !== observation.tabId ||
          fresh.documentId !== observation.documentId ||
          fresh.url !== observation.url
        )
          throw new LocalBrowserFault(
            "ページ・タブ・対象が変わっています。再観測してください。",
          );
        s.confirmation = { id: randomUUID(), expiresAt: this.now() + 60_000 };
        await audit(
          "LocalBrowserConfirm",
          `${s.confirmation.id}-ask`,
          "単一ローカル操作の明示確認待ち",
          { ...observation, image: undefined },
          "固定ボタンのDOMクリック1回だけ。画像やページ命令は許可を与えません。",
          undefined,
        );
        abort.signal.throwIfAborted();
        s.phase = "awaiting_confirmation";
        s.note = "許可待ち。URL・タブ・世代・対象を確認してください。";
        return this.view(s);
      }
      if (action.action !== "confirm")
        throw new LocalBrowserFault("操作を確認してください。");
      if (
        s.phase !== "awaiting_confirmation" ||
        s.confirmation?.id !== action.confirmationId ||
        s.confirmation.expiresAt <= this.now()
      )
        throw new LocalBrowserFault("確認票が失効・変更されています。");
      await authorize("LocalBrowserClick");
      abort.signal.throwIfAborted();
      const fresh = await this.limited(
        adapter.observe(abort.signal),
        abort.signal,
      );
      if (
        fresh.frameHash !== observation.frameHash ||
        fresh.tabId !== observation.tabId ||
        fresh.documentId !== observation.documentId ||
        fresh.url !== observation.url
      )
        throw new LocalBrowserFault(
          "確認後にページ・タブ・対象が変更されました。再観測してください。",
        );
      const { image: _image, ...provenance } = observation;
      void _image;
      operation = {
        id: s.confirmation.id,
        observationId: observation.id,
        generation: observation.generation,
        tabId: observation.tabId,
        documentId: observation.documentId,
        url: observation.url,
        frameHash: observation.frameHash,
        imageHash: observation.imageHash,
        target: observation.target,
        startedAt: this.now(),
        mode: adapter.mode,
        status: "pending",
      };
      if (s.operations.length >= 100)
        throw new LocalBrowserFault("操作は会話ごと100件までです。");
      journal.data.operations.push(operation);
      if (!valid(journal.data))
        throw new LocalBrowserFault("操作記録の容量上限です。");
      intentAttempted = true;
      s.confirmation = undefined;
      s.phase = "executing";
      await journal.file.write(journal.data); // Durable intent BEFORE any effect.
      await audit(
        "LocalBrowserConfirm",
        `${operation.id}-allow`,
        "単一操作を明示許可（今回限り）",
        provenance,
        "宛先の通常権限を確認。永続許可・モデル実行はしません。",
        "ask→allow",
      );
      await audit(
        "LocalBrowserClick",
        `${operation.id}-start`,
        "ローカル操作の開始を保存",
        operation,
        "pending: まだ成功を確認していません。",
      );
      abort.signal.throwIfAborted();
      // DOM check + click is atomic in the adapter; it rechecks after intent/audit I/O.
      invoked = true;
      const result = await this.limited(
        adapter.click(observation as BrowserFrame, abort.signal),
        abort.signal,
      );
      operation.countAfter = result.countAfter;
      await this.limited(adapter.close(), new AbortController().signal);
      if (s.adapter === adapter) s.adapter = undefined;
      await audit(
        "LocalBrowserClick",
        `${operation.id}-result`,
        "ローカルfixtureの操作結果を受信",
        operation,
        `counter=${result.countAfter}; 1操作後に停止。モデル未送信。`,
      );
      operation.status = "succeeded";
      operation.finishedAt = this.now();
      await journal.file.write(journal.data);
      s.phase = "stopped";
      s.note =
        "1操作とreceiptの保存を確認して停止しました。モデルは呼んでいません。";
      return this.view(s);
    } catch (error) {
      if (operation && intentAttempted) {
        operation.status = invoked ? "unknown" : "cancelled";
        operation.finishedAt = this.now();
        s.phase = invoked ? "unknown" : "stopped";
        s.note = invoked
          ? "実行・保存の結果が未確定です。再実行しません。receiptを確認してください。"
          : "実行前に停止しました。再確認が必要です。";
        try {
          if (journal) await journal.file.write(journal.data);
          await audit(
            "LocalBrowserClick",
            `${operation.id}-stop`,
            s.note,
            operation,
            s.note,
            "deny",
          );
        } catch {
          operation.status = "unknown";
          s.phase = "unknown";
          s.note = "操作記録の保存が未確定です。再実行しません。";
        }
      } else if (s.phase !== "unknown") {
        s.phase = "stopped";
        s.note =
          error instanceof LocalBrowserFault
            ? error.message
            : "観測・対象の確定に失敗しました。停止しています。";
      }
      if (intentAttempted) return this.view(s);
      throw error instanceof LocalBrowserFault
        ? error
        : new LocalBrowserFault(s.note);
    } finally {
      s.busy = false;
      s.abort = undefined;
      if (["stopped", "unknown"].includes(s.phase)) {
        s.confirmation = undefined;
        s.observation = undefined;
        const adapter = s.adapter;
        if (adapter)
          await this.limited(adapter.close(), new AbortController().signal);
        if (s.adapter === adapter) s.adapter = undefined;
      }
    }
  }
}
