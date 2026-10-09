import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stat } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { Terminal } from "./headless/terminal.js";
import { acquireHomeWriter } from "./main/home-writer.js";
import { SessionController } from "./main/session/controller.js";
import { SessionStore } from "./main/session/store.js";
import { unavailableLegacy } from "./main/official-profile.js";
import { OfficialWorkflowService } from "./main/workflow/official/service.js";
import { ClaudeSdkManager } from "./main/workflow/official/sdk-manager.js";
import { managedClaudeStart } from "./main/workflow/official/sdk-worker-client.js";
import { ClaudeWorkflowAgent } from "./main/workflow/official/claude.js";
import { loadMainConfig, isEffort } from "./main/config/config.js";
import { loadModelCatalog } from "./main/config/model-catalog.js";
import { resolveModelPolicy } from "./main/config/catalog.js";
import { resolvePermissionMode } from "./shared/permission-modes.js";
import { redact } from "./main/core/redact.js";
import { exportExecutionReport } from "./main/session/report.js";
import {
  readReceiptReplay,
  compareReplayPermissions,
} from "./main/session/replay.js";
import { loadProjectConfig } from "./main/config/project.js";
import { WorkspaceTrust } from "./main/config/trust.js";
import type { UiEvent, Effort } from "./shared/ipc.js";
import type { OfficialWorkflowView } from "./shared/official-workflow.js";
import type { WorkflowRecord } from "./main/workflow/official/runtime.js";

const HELP = `XHarness official headless\nnode dist/headless.js [--model provider:model] [--effort level] [--cwd path] [--resume sessionId] [--mode 通常|自動|計画] [--fake] [--codex-path executable]\n--report sessionId --output new-report.html / --replay sessionId [--replay-parent parentId] [--replay-mode default|acceptEdits|plan --cwd path]\n/help /exit /stop /model [provider:model] [effort] /mode 通常|自動|計画 /resume [sessionId] /clear /history /workflow\nGUIと同じ公式Claude SDK / Codex App Server・計画承認・実装・テスト・レビューを使います。TTYでのみ計画/操作を承認できます。\n旧HTTP・Task・MCP・画像・/compact・旧実行slashは使用しません。旧履歴は閲覧できますが公式へ自動転送しません。\n終了コード: 0=正常、1=拒否/失敗/承認不能、130=Ctrl+C/実行中のEOF取消。\n`;
const FLAGS = new Set(["--help", "--fake"]);
const VALUES = new Set([
  "--model",
  "--effort",
  "--cwd",
  "--resume",
  "--mode",
  "--codex-path",
  "--report",
  "--output",
  "--replay",
  "--replay-parent",
  "--replay-mode",
]);
function argumentsOf(args: string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!;
    if (options.has(name)) throw new Error(`Duplicate option: ${name}`);
    if (FLAGS.has(name)) options.set(name, "true");
    else if (VALUES.has(name)) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing option value: ${name}`);
      options.set(name, value);
    } else
      throw new Error(
        `未対応の起動オプション: ${name}。旧HTTP/fixture指定へ切り替えません。`,
      );
  }
  return options;
}
export interface HeadlessPorts {
  input?: Readable;
  output?: Writable;
  error?: Writable;
  /** Tests only: production always checks both terminal streams. */
  interactive?: boolean;
  home?: string;
  /** Offline service seam; production constructs the shared official service. */
  service?: Pick<
    OfficialWorkflowService,
    "submitSession" | "command" | "view" | "close"
  >;
}

/** Read-only compatibility commands never initialize agents or read credentials. */
async function readOnly(
  options: Map<string, string>,
  home: string,
  write: (s: string) => void,
) {
  if (options.has("--report")) {
    if (
      !options.has("--output") ||
      [
        "--resume",
        "--model",
        "--effort",
        "--mode",
        "--replay",
        "--replay-mode",
        "--replay-parent",
        "--codex-path",
      ].some((k) => options.has(k))
    )
      throw new Error(
        "Report needs --report sessionId --output new-file.html; cannot execute or resume a model",
      );
    await exportExecutionReport(
      home,
      options.get("--report")!,
      resolve(options.get("--output")!),
      redact,
    );
    write("HTML report saved\n");
    return true;
  }
  if (options.has("--output")) throw new Error("--output requires --report");
  if (options.has("--replay")) {
    if (
      ["--resume", "--model", "--effort", "--mode", "--codex-path"].some((k) =>
        options.has(k),
      )
    )
      throw new Error("Replay cannot resume or call a model");
    const replay = await readReceiptReplay(home, options.get("--replay")!, {
      parentId: options.get("--replay-parent"),
      clean: redact,
    });
    let comparisons;
    if (options.has("--replay-mode")) {
      const mode = resolvePermissionMode(options.get("--replay-mode"));
      if (!mode || !options.has("--cwd"))
        throw new Error("Replay comparison needs a permission mode and --cwd");
      const cwd = resolve(options.get("--cwd")!);
      const project = await loadProjectConfig(home, cwd, {
        trusted: await new WorkspaceTrust(home).isTrusted(cwd),
      });
      comparisons = await compareReplayPermissions(
        replay,
        { ...project.permissions, mode },
        cwd,
        new AbortController().signal,
      );
    }
    write(
      JSON.stringify(
        {
          ...replay,
          ...(comparisons ? { permissionComparisons: comparisons } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return true;
  }
  if (options.has("--replay-mode") || options.has("--replay-parent"))
    throw new Error("Replay options require --replay");
  return false;
}

export async function headless(
  args = process.argv.slice(2),
  ports: HeadlessPorts = {},
): Promise<number> {
  const options = argumentsOf(args);
  const output = ports.output ?? process.stdout;
  const error = ports.error ?? process.stderr;
  const write = (text: string) => output.write(redact(text));
  if (options.has("--help")) {
    write(HELP);
    return 0;
  }
  const fake = options.has("--fake");
  const home = resolve(
    ports.home ??
      process.env.XHARNESS_HOME ??
      join(homedir(), fake ? ".xharness-fake" : ".xharness"),
  );
  if (await readOnly(options, home, write)) return 0;
  if (
    options.has("--resume") &&
    ["--cwd", "--model", "--effort", "--mode"].some((k) => options.has(k))
  )
    throw new Error(
      "--resumeは保存済みcwd/model/modeを保持します。変更指定は新規セッションに使ってください。",
    );
  const cwd = options.has("--cwd") ? resolve(options.get("--cwd")!) : undefined;
  if (cwd && !(await stat(cwd)).isDirectory())
    throw new Error("--cwd requires an existing directory");
  const mode = options.has("--mode")
    ? resolvePermissionMode(options.get("--mode"))
    : undefined;
  if (options.has("--mode") && !mode)
    throw new Error("Unknown permission mode");
  const config = await loadMainConfig(home);
  const model =
    options.get("--model") ??
    `${config.choice.provider}:${config.choice.model}`;
  const effort = options.get("--effort") ?? config.choice.effort;
  // Resume opens saved history independently of an unrelated invalid default.
  // A send/new-session validates the selected alias at its own boundary.
  let selection = model;
  if (!options.has("--resume")) {
    const policy = resolveModelPolicy(model, effort, undefined, config.aliases);
    selection = `${policy.provider}:${policy.model}`;
  }
  const writer = await acquireHomeWriter(home);
  let terminal: Terminal | undefined;
  let controller: SessionController | undefined;
  let service: HeadlessPorts["service"];
  let sdk: ClaudeSdkManager | undefined;
  let activeSession: string | undefined;
  let turnSignal: AbortController | undefined;
  let exitCode = 0;
  let interrupted = false;
  let stopAfterTurn = false;
  const lifetime = new AbortController();
  const cancel = () => {
    exitCode = 130;
    turnSignal?.abort();
    if (activeSession)
      void controller?.handle({ type: "abort", sessionId: activeSession });
  };
  const interrupt = () => {
    cancel();
    if (!activeSession) {
      interrupted = true;
      lifetime.abort();
    }
  };
  process.on("SIGINT", interrupt);
  try {
    const input = ports.input ?? process.stdin;
    terminal = new Terminal(
      input,
      output,
      ports.interactive ?? !!(process.stdin.isTTY && process.stdout.isTTY),
    );
    terminal.onEnd = () => {
      if (terminal!.interactive && activeSession) cancel();
    };
    terminal.onLine = (line) => {
      if (activeSession && line.trim() === "/stop") {
        cancel();
        return true;
      }
      return false;
    };
    // Record-only resume does not start or update a runtime until a native request is sent.
    service = ports.service;
    let sdkStarted = false;
    const ensureService = async () => {
      if (service) return service;
      if (!fake) {
        sdk = new ClaudeSdkManager(join(home, "runtimes", "claude-sdk"));
      }
      service = new OfficialWorkflowService({
        home,
        fake,
        codexPath: options.get("--codex-path") ?? config.auth.codexCliPath,
        ...(sdk
          ? {
              claudeRuntime: {
                agent: () =>
                  new ClaudeWorkflowAgent(
                    managedClaudeStart(sdk!.selectedEntry()),
                    sdk!.view().version,
                  ),
                view: () => sdk!.view(),
              },
            }
          : {}),
      });
      await service.command({ action: "list" });
      // Explicit command-line override wins over the saved connection file, using its validated path policy.
      if (options.has("--codex-path")) {
        const view = await service.command({
          action: "configure",
          codexPath: options.get("--codex-path")!,
        });
        if (view.error) throw new Error(view.error);
      }
      return service;
    };
    const seen = new Set<string>();
    const emit = (event: UiEvent) => {
      if (event.type === "error") {
        error.write(redact(event.message) + "\n");
        exitCode ||= 1;
      }
      if (event.type === "notice") write(event.message + "\n");
      if (event.type === "transcript")
        for (const item of event.items) {
          const key = `${event.sessionId}:${item.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (item.kind === "assistant" || item.kind === "user")
            write(`${item.kind}: ${item.text}\n`);
        }
      if (
        event.type === "turn" &&
        event.status === "idle" &&
        event.stopCause &&
        !["end_turn", "workflow_complete", "awaiting_user"].includes(
          event.stopCause,
        )
      )
        exitCode ||= 1;
    };
    controller = new SessionController({
      home,
      model: selection,
      effort: effort as Effort,
      cliModel: options.has("--model") ? selection : undefined,
      cliEffort: options.get("--effort") as Effort | undefined,
      fake,
      phase4: true,
      version: "headless",
      provider: unavailableLegacy("claude"),
      providers: [unavailableLegacy("claude"), unavailableLegacy("codex")],
      fallback: {},
      aliases: config.aliases,
      officialSession: async (request, signal) => {
        const connected = await ensureService();
        if (sdk && !sdkStarted) {
          await sdk.start();
          sdkStarted = true;
        }
        signal.throwIfAborted();
        return connected.submitSession(request, signal);
      },
      host: { pickFolder: async () => cwd },
      emit,
    });
    await controller.init();
    const store = new SessionStore(home);
    let sessionId = "";
    let legacy = false;
    let workspaceId: string | null = null;
    const open = async (id: string) => {
      await store.load();
      const saved = store.get(id);
      if (!saved) throw new Error("Unknown session");
      const messages = await store.messages(id);
      legacy =
        saved.model === "fake" ||
        (messages.length > 0 &&
          !messages.some(
            (m) => m.role === "assistant" && m.meta?.officialWorkflow,
          )) ||
        messages.some(
          (m) => m.role === "assistant" && !m.meta?.officialWorkflow,
        );
      const result = await controller!.handle({
        type: "open_session",
        sessionId: id,
      });
      if (!result.ok) throw new Error(result.error);
      sessionId = id;
      workspaceId = saved.workspaceId;
      write(`${saved.cwd} · session ${id} · ${saved.model}\n`);
      if (legacy)
        write(
          "旧会話は閲覧専用です。モデル/履歴/権限を変更せず保持します。/clearで新しい公式会話を開始してください。\n",
        );
    };
    const fresh = async () => {
      const result = await controller!.handle({
        type: "new_session",
        workspaceId,
      });
      if (!result.ok || !result.sessionId)
        throw new Error(result.ok ? "Missing session" : result.error);
      sessionId = result.sessionId;
      legacy = false;
      if (mode) await controller!.handle({ type: "set_mode", sessionId, mode });
      const saved = (await controller!.state()).sessions.find(
        (s) => s.id === sessionId,
      )!;
      write(`${saved.cwd} · session ${sessionId} · ${saved.model}\n`);
    };
    if (options.has("--resume")) await open(options.get("--resume")!);
    else {
      if (cwd) {
        const selected = await controller.handle({ type: "pick_folder" });
        if (!selected.ok || !selected.workspaceId)
          throw new Error(selected.ok ? "Missing workspace" : selected.error);
        workspaceId = selected.workspaceId;
      }
      await fresh();
    }
    write("公式headless。旧HTTPへ切替なし。/helpで対応操作を確認できます。\n");
    const printSelection = (call: WorkflowRecord["calls"][number]) => {
      const selection = call.modelSelection;
      if (!selection) {
        write(
          `  ${call.phase}: ${call.requestedModel} / ${call.effort ?? "既定"}（alias/catalog解決記録なし）\n`,
        );
        return;
      }
      const previous = selection.previous;
      write(
        `  ${call.phase}: ${selection.policy.provider}:${selection.policy.model} → ${selection.resolved.model} / ${selection.resolved.effort ?? "既定"} · catalog ${selection.resolved.catalog.version}/${selection.resolved.catalog.updatedAt}/${selection.resolved.catalog.digest} · ${previous ? `${previous.model} → ${selection.resolved.model}（${selection.changed ? "変更あり" : "変更なし"}）` : "前回の解決記録なし"}\n`,
      );
    };
    const printView = (view: OfficialWorkflowView) => {
      for (const { record } of view.records) {
        write(`workflow ${record.id} · ${record.status} · ${record.goal}\n`);
        for (const call of record.calls) printSelection(call);
      }
    };
    const printedCalls = new Set<string>();
    while (!interrupted && !stopAfterTurn) {
      const line = await terminal.read("❯ ", lifetime.signal);
      if (line === undefined) break;
      const text = line.trim();
      if (!text) continue;
      if (text === "/exit") break;
      if (text === "/help") {
        write(HELP);
        continue;
      }
      if (text === "/history") {
        for (const message of await store.messages(sessionId))
          write(
            `${message.role}: ${message.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("\n")}\n`,
          );
        continue;
      }
      if (text === "/resume") {
        await store.load();
        for (const saved of store.list())
          write(`${saved.id} · ${saved.title} · ${saved.model}\n`);
        continue;
      }
      if (text.startsWith("/resume ")) {
        await open(text.slice(8).trim());
        continue;
      }
      if (text === "/clear") {
        await fresh();
        continue;
      }
      if (text === "/workflow") {
        printView(await (await ensureService()).command({ action: "list" }));
        continue;
      }
      if (legacy) {
        error.write(
          "旧会話へ送信・設定変更できません。/clearで新しい公式会話を開始してください。\n",
        );
        exitCode ||= 1;
        continue;
      }
      const pieces = text.split(/\s+/);
      if (pieces[0] === "/model") {
        if (pieces.length === 1) {
          for (const m of loadModelCatalog().filter((m) => m.enabled))
            write(`${m.provider}:${m.alias ?? m.id} → ${m.id}\n`);
          continue;
        }
        if (pieces.length > 3 || (pieces[2] && !isEffort(pieces[2]))) {
          error.write("Usage: /model provider:model [effort]\n");
          exitCode ||= 1;
          continue;
        }
        const result = await controller.handle({
          type: "set_model",
          sessionId,
          model: pieces[1]!,
          effort: pieces[2] as Effort | undefined,
        });
        if (!result.ok) {
          error.write(redact(result.error) + "\n");
          exitCode ||= 1;
        }
        continue;
      }
      if (pieces[0] === "/mode") {
        const chosen = resolvePermissionMode(pieces[1]);
        if (!chosen || pieces.length !== 2) {
          error.write("Usage: /mode 通常|自動|計画\n");
          exitCode ||= 1;
          continue;
        }
        const result = await controller.handle({
          type: "set_mode",
          sessionId,
          mode: chosen,
        });
        if (!result.ok) {
          error.write(redact(result.error) + "\n");
          exitCode ||= 1;
        }
        continue;
      }
      if (text.startsWith("/") && text !== "/stop") {
        error.write(
          "旧実行slash・Task・MCP・圧縮・巻き戻しは公式headlessで非対応です。/helpを確認してください。\n",
        );
        exitCode ||= 1;
        continue;
      }
      turnSignal = new AbortController();
      activeSession = sessionId;
      try {
        if (terminal.interactive && terminal.ended) {
          write("TTYが終了したため新しい実行を開始しません。\n");
          exitCode ||= 130;
          break;
        }
        const sent = await controller.handle({ type: "send", sessionId, text });
        if (!sent.ok) {
          error.write(redact(sent.error) + "\n");
          exitCode ||= 1;
          continue;
        }
        let lastStatus = "";
        while (
          (await controller.state()).sessions.find((s) => s.id === sessionId)
            ?.status !== "idle"
        ) {
          const view = service?.view();
          const record = view?.records.find(
            (r) => r.record.id === view.activeId,
          )?.record;
          const status = record
            ? `${record.id}:${record.status}:${record.calls.length}:${record.correctionRounds}`
            : "";
          if (record && status !== lastStatus) {
            write(
              `workflow ${record.id} · ${record.status} · calls ${record.calls.length} · fix ${record.correctionRounds}\n`,
            );
            record.calls.forEach((call, index) => {
              const key = `${record.id}:${index}`;
              if (!printedCalls.has(key)) {
                printSelection(call);
                printedCalls.add(key);
              }
            });
            lastStatus = status;
          }
          const plan = view?.approval;
          const operation = view?.operationApproval;
          if (plan || operation) {
            const id = plan?.id ?? operation!.workflowId;
            write(
              plan
                ? `計画 ${id}\n${JSON.stringify(record?.plan ?? view?.records.find((r) => r.record.id === id)?.record.plan, null, 2)}\n`
                : `操作承認\n${JSON.stringify(operation, null, 2)}\n`,
            );
            if (plan?.autoOperations)
              write(
                "自動モード: この計画を承認すると、この実行の操作確認も許可されます。\n",
              );
            if (!terminal.interactive) {
              stopAfterTurn = true;
              error.write(
                "非TTYでは計画/操作を承認できません。無断許可せず記録を保全して停止しました。\n",
              );
              exitCode ||= 1;
              await service!.command({ action: "cancel", id });
            } else {
              // A native timeout/cancellation must also release the terminal prompt.
              const expired = new AbortController();
              const invalidation = setInterval(() => {
                const current = service!.view();
                const pending = plan
                  ? current.approval
                  : current.operationApproval;
                if (
                  !pending ||
                  pending.digest !== (plan?.digest ?? operation!.digest) ||
                  (operation && Date.now() >= operation.expiresAt)
                )
                  expired.abort();
              }, 20);
              let answer: string | undefined;
              try {
                answer = await terminal.read(
                  "承認しますか？ [y/N] ",
                  AbortSignal.any([turnSignal.signal, expired.signal]),
                );
              } finally {
                clearInterval(invalidation);
              }
              if (answer?.trim().toLowerCase() === "y") {
                await service!.command(
                  plan
                    ? { action: "approve", id, digest: plan.digest }
                    : {
                        action: "tool_decision",
                        id,
                        approvalId: operation!.approvalId,
                        digest: operation!.digest,
                        allow: true,
                      },
                );
              } else {
                exitCode ||=
                  terminal.ended || turnSignal.signal.aborted ? 130 : 1;
                await service!.command(
                  operation && answer !== undefined && !expired.signal.aborted
                    ? {
                        action: "tool_decision",
                        id,
                        approvalId: operation.approvalId,
                        digest: operation.digest,
                        allow: false,
                      }
                    : { action: "cancel", id },
                );
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        activeSession = undefined;
        turnSignal = undefined;
      }
    }
    return exitCode;
  } finally {
    process.off("SIGINT", interrupt);
    const closed = await Promise.allSettled([
      controller?.shutdown(),
      service?.close(),
      sdk?.close(),
    ]);
    terminal?.close();
    await writer.release();
    for (const result of closed)
      if (result.status === "rejected") throw result.reason;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  headless()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        redact(
          error instanceof Error
            ? error.message
            : "公式headlessを開始できません。旧HTTPへ切り替えません。",
        ) + "\n",
      );
      process.exitCode = 1;
    });
}
