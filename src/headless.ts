import { withSessionTrace } from "./main/core/trace.js";
import { readLlmCalls, withSessionCalls } from "./main/session/llm-calls.js";
import {
  costSummary,
  expandCommand,
  initAgents,
  userCommands,
} from "./main/session/slash-commands.js";
import { reservedCommand } from "./shared/commands.js";
import { ReceiptStore } from "./main/session/receipts.js";
import { pad, toReceipt } from "./main/session/context.js";
import { type Receipt } from "./shared/ipc.js";
import { loadModelCatalog } from "./main/config/model-catalog.js";
import { LlmBudgetError } from "./main/core/llm-budget.js";
import { projectHookApproval } from "./main/hooks/shell-hooks.js";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { stat, rm } from "node:fs/promises";
import { FileCheckpointStore } from "./main/checkpoints/store.js";
import { headlessRewind } from "./main/session/headless-rewind.js";
import { rewindTurns } from "./shared/rewind.js";
import { randomUUID } from "node:crypto";
import {
  SessionStore,
  WorkspaceStore,
  JsonFile,
  type StoredSession,
} from "./main/session/store.js";
import {
  loadProjectConfig,
  projectMemory,
  saveRule,
} from "./main/config/project.js";
import {
  decidePermission,
  grantFor,
  normalizeCall,
  type Rule,
  permissionModes,
} from "./main/core/permissions.js";
import { estimateTokens, type Checkpoint } from "./main/context/compactor.js";
import { WorkflowRuntime } from "./main/workflow/runtime.js";
import { prepareProviderHistory } from "./main/context/provider-compactor.js";
import { loadAgentConfig } from "./main/agents/definitions.js";
import { waveChecks } from "./main/workflow/wave-checks.js";
import { defaultTools } from "./main/session/controller.js";
import { childNeedsAsk } from "./main/agents/permissions.js";
import { type Message } from "./main/core/types.js";
import { redact } from "./main/core/redact.js";
import { WorkspaceTrust } from "./main/config/trust.js";
import { McpApprovals } from "./main/mcp/approvals.js";
import {
  displayServer,
  loadMcpConfig,
  type McpServerConfig,
} from "./main/mcp/config.js";
import { McpManager } from "./main/mcp/manager.js";
import {
  MCP_PROMPT_COMMAND,
  mcpChangeNote,
  mcpLogger,
  parseMcpPrompt,
} from "./main/session/mcp-session.js";
import { mcpTools } from "./main/tools/mcp.js";
import { readLocalSecrets } from "./main/auth/local-secrets.js";
import { FakeProvider } from "./main/providers/fake/fake-provider.js";
import { ClaudeAdapter } from "./main/providers/claude/adapter.js";
import { CodexAdapter } from "./main/providers/codex/adapter.js";
import { Router } from "./main/core/router.js";
import {
  isEffort,
  resolveModel,
  loadMainConfig,
} from "./main/config/config.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ReasoningEffort } from "./main/providers/provider.js";
import { FileAccess, fileTools } from "./main/tools/files.js";
import { shellSearchTools } from "./main/tools/shell-search.js";
import { todoTools } from "./main/tools/todos.js";
import { diagnoseEnvironment } from "./main/tools/environment.js";
import { webTools } from "./main/tools/web.js";
import {
  readReceiptReplay,
  compareReplayPermissions,
} from "./main/session/replay.js";
import { exportExecutionReport } from "./main/session/report.js";

export async function headless(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    process.stdout.write(
      "XHarness Phase 6\nnode dist/headless.js [--model provider:model] [--cwd path] [--resume id] [--fake [--fixtures dir]]\nnode dist/headless.js --replay sessionId [--replay-parent parentId] [--replay-mode default|acceptEdits|plan --cwd path] [--fake]\nnode dist/headless.js --report sessionId --output new-report.html [--fake]\n/model provider:model [effort] /mode default|acceptEdits|plan /phase plan|implement|review /review /compact /exit /clear · Ctrl+C interrupts a turn\n",
    );
    return;
  }
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
  };
  const fake = args.includes("--fake");
  const home =
    process.env.XHARNESS_HOME ??
    join(homedir(), fake ? ".xharness-fake" : ".xharness");
  if (args.includes("--report")) {
    const id = option("--report", "");
    const output = option("--output", "");
    if (!id || id.startsWith("--") || !output || output.startsWith("--"))
      throw new Error("Report needs --report sessionId --output new-file.html");
    if (
      [
        "--resume",
        "--model",
        "--effort",
        "--replay",
        "--replay-mode",
        "--replay-parent",
      ].some((name) => args.includes(name))
    )
      throw new Error("Report cannot resume or call a model");
    const secrets = fake ? [] : await readLocalSecrets();
    await exportExecutionReport(home, id, resolve(output), (text) =>
      redact(text, secrets),
    );
    process.stdout.write("HTML report saved\n");
    return;
  }
  if (args.includes("--output")) throw new Error("--output requires --report");
  if (args.includes("--replay")) {
    const value = (name: string) => {
      const result = option(name, "");
      if (!result || result.startsWith("--"))
        throw new Error("Missing replay option value");
      return result;
    };
    if (["--resume", "--model", "--effort"].some((name) => args.includes(name)))
      throw new Error("Replay cannot resume or call a model");
    const secrets = fake ? [] : await readLocalSecrets();
    const replay = await readReceiptReplay(home, value("--replay"), {
      parentId: args.includes("--replay-parent")
        ? value("--replay-parent")
        : undefined,
      clean: (text) => redact(text, secrets),
    });
    let comparisons;
    if (args.includes("--replay-mode")) {
      const mode = value("--replay-mode");
      if (
        !permissionModes.includes(mode as (typeof permissionModes)[number]) ||
        !args.includes("--cwd")
      )
        throw new Error("Replay comparison needs a permission mode and --cwd");
      const cwd = resolve(value("--cwd"));
      const project = await loadProjectConfig(home, cwd, {
        trusted: await new WorkspaceTrust(home).isTrusted(cwd),
      });
      comparisons = await compareReplayPermissions(
        replay,
        {
          ...project.permissions,
          mode: mode as (typeof permissionModes)[number],
        },
        cwd,
        new AbortController().signal,
      );
    }
    process.stdout.write(
      JSON.stringify(
        {
          ...replay,
          ...(comparisons ? { permissionComparisons: comparisons } : {}),
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }
  if (args.includes("--replay-mode") || args.includes("--replay-parent"))
    throw new Error("Replay options require --replay");
  const sessions = new SessionStore(home);
  await sessions.load();
  const resume = args.includes("--resume")
    ? sessions.get(option("--resume", ""))
    : undefined;
  if (args.includes("--resume") && !resume) throw new Error("Unknown session");
  const cwd = resume?.cwd ?? resolve(option("--cwd", process.cwd()));
  if (!(await stat(cwd)).isDirectory())
    throw new Error("Working directory unavailable");
  const config = await loadMainConfig(home, undefined, cwd);
  // headless は信頼の確認を出さない。アプリで信頼したワークスペースだけ、設定の許可ルールを適用する
  const project = await loadProjectConfig(home, cwd, {
    trusted: await new WorkspaceTrust(home).isTrusted(cwd),
  });
  if (project.untrusted)
    process.stderr.write(
      "Project settings in this folder grant extra permissions but the folder is not trusted; those entries are ignored (trust it from the app).\n",
    );
  let model =
    fake && !args.includes("--model")
      ? "fake"
      : resolveModel(
          option("--model", resume?.model ?? config.choice.model),
          config.aliases,
        )?.model;
  if (resume && !args.includes("--model")) model = resume.model;
  if (!model) throw new Error("Unknown model");
  const cliEffort = option("--effort", resume?.effort ?? config.choice.effort);
  if (!isEffort(cliEffort)) throw new Error("Unknown effort");
  let effort: ReasoningEffort = cliEffort;
  const providers = fake
    ? [
        new FakeProvider({
          fixturesDir: option(
            "--fixtures",
            fileURLToPath(new URL("../test/fixtures/claude", import.meta.url)),
          ),
        }),
        new FakeProvider({
          provider: "codex",
          fixturesDir: fileURLToPath(
            new URL("../test/fixtures/codex", import.meta.url),
          ),
        }),
      ]
    : [
        new ClaudeAdapter(),
        new CodexAdapter({
          toolImageMode: async () =>
            (await loadMainConfig(home)).providers.codex.toolImageMode,
        }),
      ];
  const router = new Router(providers, config?.fallback, config?.aliases);
  router.provider(model);
  const access = new FileAccess(cwd);
  const tools = new Map([
    ...fileTools(access),
    ...shellSearchTools(cwd),
    ...todoTools(),
  ]);
  // 検索回数の上限は、子エージェントを含むセッション全体で数える(§22.6)
  const searchBudget = {
    used: 0,
    limit: config?.web.maxSearchesPerSession ?? 100,
  };
  if (config?.web.enabled !== false)
    for (const [name, tool] of webTools(
      () => router.provider(model!),
      config?.web.searchMode ?? "live",
      fake,
      undefined,
      {
        settings: config?.web,
        providers: () => providers,
        budget: searchBudget,
      },
    ))
      tools.set(name, tool);
  // --fake は通信も資格情報の読み取りも行わない。
  const secrets = fake ? [] : await readLocalSecrets();
  const clean = (text: string) => redact(text, secrets);
  let system = `You are a coding agent working in ${cwd}. Use Read before modifying existing files. Bash executes PowerShell 7 and already runs in this working directory, so do not prefix commands with cd or Set-Location. Tool dates use ISO 8601. Respect project instructions.`;
  const environment = resume?.environment ?? (await diagnoseEnvironment(cwd));
  if (!resume?.environment)
    for (const warning of environment.warnings) console.error(warning);
  system += "\n" + environment.summary;
  system +=
    "\n\n" + clean(await projectMemory(home, cwd, project.context.memoryFiles));
  const workspaces = new WorkspaceStore(home);
  await workspaces.load();
  const workspaceId = resume?.workspaceId ?? (await workspaces.add(cwd));
  let session: StoredSession = resume ?? {
    environment,
    id: randomUUID().slice(0, 8),
    title: "Headless session",
    cwd,
    workspaceId,
    readOnly: false,
    model,
    effort,
    permissionMode: project.permissions.mode,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    providers: [],
  };
  session = { ...session, environment };
  await sessions.save(session);
  let messages: Message[] = resume ? await sessions.messages(session.id) : [];
  let persisted = messages.length;
  const fileCheckpoints = new FileCheckpointStore(home);
  await fileCheckpoints.purge(
    project.checkpoints?.retentionDays ?? 30,
    Date.now(),
    true,
  );
  let checkpoint: Checkpoint | undefined;
  const checkpointFile = () =>
    new JsonFile<Checkpoint | undefined>(
      join(home, "context", `${session.id}.json`),
      (v): v is Checkpoint | undefined =>
        v === undefined ||
        (!!v &&
          typeof v === "object" &&
          Number.isSafeInteger((v as Checkpoint).covered) &&
          (v as Checkpoint).covered >= 0 &&
          typeof (v as Checkpoint).summary === "string"),
    );
  checkpoint = await checkpointFile().read(undefined);
  const sessionRules: Rule[] = [];
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
  });
  let controller: AbortController | undefined;
  let workflow: WorkflowRuntime | undefined;
  let closed = false;
  let resumeNext: string | undefined;
  const receiptStore = new ReceiptStore(home);
  let receiptSeq = Math.max(
    0,
    ...(await receiptStore.read(session.id)).map(
      (r) => Number(r.id.slice(1)) || 0,
    ),
  );
  const childReceipts: Receipt[] = [];
  const interrupt = () => {
    if (controller) controller.abort();
    else {
      closed = true;
      rl.close();
    }
  };
  rl.on("SIGINT", interrupt);
  rl.on("close", () => {
    closed = true;
    controller?.abort();
  });
  process.on("SIGINT", interrupt);
  process.stdout.write(
    `XHarness · ${model} · ${cwd} · session ${session.id}\n/exit to quit, /clear starts a new session.\n`,
  );
  // MCP(§25): 起動時に1回だけ準備し、tools をセッション中に変えない。--fake では起動しない
  let mcp: McpManager | undefined;
  const mcpConfig =
    !fake && config.mcp.enabled ? await loadMcpConfig(cwd) : undefined;
  if (mcpConfig?.exists) {
    for (const warning of mcpConfig.warnings)
      process.stderr.write(clean(warning) + "\n");
    mcp = new McpManager({
      cwd,
      startupTimeoutMs: config.mcp.startupTimeoutSec * 1000,
      toolTimeoutMs: config.mcp.toolTimeoutSec * 1000,
      redact: clean,
      log: await mcpLogger(home, cwd),
    });
    if (!(await new WorkspaceTrust(home).isTrusted(cwd)))
      process.stderr.write(
        "This folder is not trusted; MCP servers in .mcp.json are not started (trust it from the app).\n",
      );
    else {
      const approvals = await McpApprovals.open(home, cwd);
      const approved: McpServerConfig[] = [];
      for (const server of mcpConfig.servers) {
        const saved = await approvals.get(server.name, server.hash);
        if (saved === "rejected") continue;
        if (saved !== "approved") {
          const answer = (
            await rl.question(
              `Start MCP server ${clean(JSON.stringify(displayServer(server)))}? [y: this session / a: always / N] `,
            )
          )
            .trim()
            .toLowerCase();
          if (answer === "a")
            await approvals.set(server.name, server.hash, "approved");
          else if (answer !== "y") continue;
        }
        approved.push(server);
      }
      await mcp.connect(approved, AbortSignal.timeout(600_000));
      for (const state of mcp.states())
        process.stdout.write(
          `MCP ${state.name}: ${state.status}${state.error ? ` (${state.error})` : ""}\n`,
        );
    }
    for (const [name, tool] of mcpTools(mcp)) tools.set(name, tool);
  }
  try {
    while (!closed) {
      let input: string;
      try {
        input = await rl.question("❯ ");
      } catch {
        break;
      }
      if (input.trim() === "/exit") break;
      if (/^\/resume(?:\s|$)/.test(input.trim())) {
        const [, id, extra] = input.trim().split(/\s+/);
        if (!id)
          process.stdout.write(
            "再開する会話（/resume <sessionId>）：\n" +
              clean(
                sessions
                  .list()
                  .map((s) => `${s.id} · ${s.title}`)
                  .join("\n"),
              ) +
              "\n",
          );
        else if (extra || !sessions.get(id))
          process.stdout.write("会話が見つかりません。\n");
        else {
          resumeNext = id;
          break;
        }
        continue;
      }
      if (input.trim() === "/cost") {
        process.stdout.write(
          costSummary(
            await readLlmCalls(home, session.id),
            await new ReceiptStore(home).read(session.id),
          ) + "\n",
        );
        continue;
      }
      if (input.trim() === "/init") {
        const result = await initAgents(
          cwd,
          session.readOnly || session.permissionMode === "plan",
        );
        process.stdout.write(
          result.ok ? "AGENTS.mdの雛形を作成しました。\n" : result.error + "\n",
        );
        continue;
      }
      if (/^\/(?:undo|rewind)(?:\s|$)/.test(input.trim())) {
        controller = new AbortController();
        try {
          const count = rewindTurns(input.trim());
          if (!count) throw new Error();
          const scope = await headlessRewind(
            fileCheckpoints,
            sessions,
            session.id,
            count,
            (prompt) => rl.question(prompt, { signal: controller!.signal }),
            (text) => process.stdout.write(text),
            clean,
            controller.signal,
          );
          if (scope) {
            messages = await sessions.messages(session.id);
            persisted = messages.length;
            access.reads.clear();
            workflow = undefined;
            if (scope !== "code") {
              checkpoint = undefined;
              await rm(join(home, "context", session.id + ".json"), {
                force: true,
              });
            }
          }
        } catch {
          process.stdout.write(
            "巻き戻しを完了できませんでした。指定・期限・アクセス権限を確認してください。\n",
          );
        } finally {
          controller = undefined;
        }
        continue;
      }
      if (/^\/(?:phase|review)(?:\s|$)/.test(input.trim())) {
        const [command, phase, extra] = input.trim().split(/\s+/);
        const requested = command === "/review" ? "review" : (phase ?? "");
        try {
          if (!workflow || extra || (command === "/review" && phase))
            throw new Error();
          workflow.manualPhase(requested);
        } catch {
          process.stdout.write("No workflow or invalid phase transition\n");
          continue;
        }
        if (requested !== "review") continue;
      }
      if (input.trim() === "/clear") {
        workflow = undefined;
        messages = [];
        persisted = 0;
        checkpoint = undefined;
        sessionRules.length = 0;
        session = {
          ...session,
          id: randomUUID().slice(0, 8),
          title: "Headless session",
          model,
          effort,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await sessions.save(session);
        process.stdout.write(`Session: ${session.id}\n`);
        access.reads.clear();
        continue;
      }
      if (input.trim() === "/compact") {
        const compactAbort = new AbortController();
        try {
          const prepared = await withSessionCalls(
            {
              home,
              id: session.id,
              limits: project.limits,
              abort: compactAbort,
            },
            async (budget) => {
              const value = await withSessionTrace(
                home,
                session.id,
                clean,
                () =>
                  prepareProviderHistory(messages, {
                    provider: router.provider(model!),
                    model: model!,
                    system,
                    tools: [...tools.values()].map((t) => t.spec),
                    signal: AbortSignal.any([
                      compactAbort.signal,
                      AbortSignal.timeout(60000),
                    ]),
                    checkpoint,
                    force: true,
                    threshold: project.context.compactThreshold,
                  }),
                {
                  onWarning: (message) => process.stderr.write(message + "\n"),
                },
              );
              if (budget.stopCause) throw new LlmBudgetError(budget.stopCause);
              return value;
            },
          );
          checkpoint = prepared.checkpoint;
          if (checkpoint) await checkpointFile().write(checkpoint);
          process.stdout.write(
            prepared.compacted
              ? "History compacted; original retained\n"
              : "No older history to compact\n",
          );
        } catch (error) {
          if (!(error instanceof LlmBudgetError)) throw error;
          process.stdout.write(`[stopped: ${error.reason}]\n`);
        }
        continue;
      }
      if (/^\/mode(?:\s|$)/.test(input.trim())) {
        const [, mode, extra] = input.trim().split(/\s+/);
        if (
          !extra &&
          permissionModes.includes(mode as (typeof permissionModes)[number]) &&
          (!session.readOnly || mode === "plan")
        ) {
          session.permissionMode = mode as (typeof permissionModes)[number];
          await sessions.save(session);
        } else process.stdout.write("Usage: /mode default|acceptEdits|plan\n");
        continue;
      }
      if (/^\/model(?:\s|$)/.test(input.trim())) {
        const [, spec, level, extra] = input.trim().split(/\s+/);
        if (!spec) {
          process.stdout.write(
            `Model: ${model} · ${effort}\n/model <provider:model> [effort]\n` +
              loadModelCatalog()
                .filter((m) => m.enabled)
                .map((m) => m.id)
                .join("\n") +
              "\n",
          );
          continue;
        }
        const choice = spec && resolveModel(spec, config?.aliases);
        if (!choice || extra || (level !== undefined && !isEffort(level))) {
          process.stdout.write("Usage: /model provider:model [effort]\n");
          continue;
        }
        try {
          router.provider(choice.model);
        } catch {
          process.stdout.write("Unknown model\n");
          continue;
        }
        model = choice.model;
        if (isEffort(level)) effort = level;
        process.stdout.write(`Model: ${model} · ${effort}\n`);
        continue;
      }
      if (!input.trim()) continue;
      if (input.trim() === "/mcp") {
        // MCP の状態(§25.8)。操作(承認の取り消し・ログアウト)はアプリの /mcp で行う
        const states = mcp?.states() ?? [];
        if (!states.length) process.stdout.write("MCP: no servers\n");
        for (const state of states)
          process.stdout.write(
            `MCP ${state.name} (${state.type}): ${state.status}` +
              (state.status === "connected"
                ? ` · tools ${state.tools} · resources ${state.resources ?? 0} · prompts ${state.prompts ?? 0}`
                : "") +
              (state.error ? ` (${clean(state.error)})` : "") +
              "\n",
          );
        for (const prompt of mcp?.prompts() ?? [])
          process.stdout.write(
            `  /mcp__${prompt.server}__${prompt.name} ${prompt.arguments
              .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
              .join(" ")}\n`,
          );
        continue;
      }
      let mcpExpanded = false;
      if (MCP_PROMPT_COMMAND.test(input.trim())) {
        // MCP のプロンプト(§25.6): 展開した内容を見せ、y で通常の発言として送る
        const parsed = parseMcpPrompt(mcp, input);
        let expanded = "";
        if ("error" in parsed) process.stdout.write(parsed.error + "\n");
        else
          try {
            expanded = await mcp!.prompt(
              parsed.server,
              parsed.name,
              parsed.args,
              AbortSignal.timeout(60_000),
            );
          } catch {
            process.stdout.write("MCP のプロンプトを取得できませんでした\n");
          }
        if (!expanded.trim()) continue;
        const ok = await rl.question(
          `\n${clean(expanded.slice(0, 4000))}\n\nSend this MCP prompt? [y/N] `,
        );
        if (ok.trim().toLowerCase() !== "y") continue;
        input = expanded;
        mcpExpanded = true;
      }
      const customName = mcpExpanded
        ? undefined
        : /^\/([^\s]+)/.exec(input.trim())?.[1];
      if (customName && !reservedCommand(customName)) {
        const expanded = expandCommand(
          input,
          await userCommands(
            home,
            cwd,
            await new WorkspaceTrust(home).isTrusted(cwd),
          ),
        );
        if (expanded === undefined) {
          process.stdout.write(
            "コマンドが見つからないか、プロジェクトが未信頼です。\n",
          );
          continue;
        }
        input = expanded;
      } else if (
        customName &&
        ["clear", "resume", "cost", "init", "stop", "compact", "exit"].includes(
          customName,
        )
      ) {
        process.stdout.write(
          customName === "stop"
            ? "現在は実行していません。実行中はCtrl+Cで停止できます。\n"
            : "コマンドの引数を確認してください。\n",
        );
        continue;
      }
      controller = new AbortController();
      let fileCheckpoint;
      try {
        await fileCheckpoints.purge(project.checkpoints?.retentionDays ?? 30);
        fileCheckpoint = await fileCheckpoints.begin(
          session.id,
          cwd,
          messages.length,
          clean,
          (message) => process.stdout.write(clean(message) + "\n"),
        );
      } catch {
        controller = undefined;
        process.stdout.write(
          "チェックポイントを準備できませんでした。保存先・アクセス権限を確認してください。\n",
        );
        continue;
      }
      let bufferedText = "";
      // MCP の一覧の変化は、モデルにだけ注記で伝える(tools は変えない。§25.4)
      const note = mcpChangeNote(mcp);
      messages.push({
        role: "user",
        content: [
          { type: "text", text: clean(input) },
          ...(note ? [{ type: "text" as const, text: clean(note) }] : []),
        ],
      });
      const ask = async (
        call: { name: string; input: unknown },
        signal: AbortSignal,
        directory = cwd,
        force = false,
      ) => {
        signal.throwIfAborted();
        const fullCall = { ...call, id: "headless" };
        const decision = force
          ? "ask"
          : await decidePermission(
              fullCall,
              {
                ...project.permissions,
                mode: session.permissionMode ?? project.permissions.mode,
              },
              directory,
              { readOnly: session.readOnly, sessionRules },
            );
        if (decision !== "ask") return decision === "allow";
        const answer = await rl.question(
          `\nAllow ${clean(call.name + " " + JSON.stringify(call.input))}? [y: once / s: session / a: always / N] `,
          { signal },
        );
        signal.throwIfAborted();
        const choice = answer.trim().toLowerCase();
        // cwd への cd・McpCall は、判定と同じ形にそろえてから保存する
        const normalized = await normalizeCall(fullCall, directory);
        if (choice === "s" && !force) sessionRules.push(grantFor(normalized));
        if (choice === "a" && !force) {
          const grant = grantFor({
            ...normalized,
            input: JSON.parse(
              clean(JSON.stringify(normalized.input)),
            ) as unknown,
          });
          await saveRule(home, grant, cwd);
          project.permissions.rules.push(grant);
        }
        return ["y", "s", "a"].includes(choice);
      };
      if (
        !workflow ||
        (!workflow.manualReview &&
          ["off", "complete", "attention"].includes(workflow.state.phase))
      ) {
        const agentConfig = await loadAgentConfig(home, cwd);
        const approveHooks = projectHookApproval(
          agentConfig.hooks ?? [],
          (hooks, signal) =>
            ask({ name: "ProjectHooks", input: { hooks } }, signal, cwd, true),
        );
        workflow = new WorkflowRuntime({
          approveHooks: (_hooks, signal) => approveHooks(signal),
          home,
          cwd,
          parentId: session.id,
          config: agentConfig,
          aliases: config.aliases,
          router,
          createTools: (directory) => {
            const available = defaultTools(directory, false);
            if (config.web.enabled)
              for (const [name, tool] of webTools(
                () => router.provider(model!),
                config.web.searchMode,
                fake,
                undefined,
                {
                  settings: config.web,
                  providers: () => providers,
                  budget: searchBudget,
                },
              ))
                available.set(name, tool);
            if (mcp)
              for (const [name, tool] of mcpTools(mcp))
                available.set(name, tool);
            return available;
          },
          permission: async (call, context, signal) =>
            call.name === "ReportDone"
              ? true
              : ask(
                  call,
                  signal,
                  context.cwd,
                  await childNeedsAsk(call, context),
                ),
          approve: (items, notes, warnings, signal) =>
            ask(
              { name: "SubmitPlan", input: { items, notes, warnings } },
              signal,
              cwd,
              true,
            ),
          waveChecks: waveChecks(
            agentConfig.waveChecks,
            shellSearchTools(cwd).get("Bash")!,
            (_hooks, signal) => approveHooks(signal),
          ),
          onStatus: (context, model, status) =>
            process.stdout.write(`\n${context.name} · ${model} · ${status}\n`),
          onEvent: (context, event) => {
            if (event.type === "receipt")
              childReceipts.push({
                ...toReceipt(event.receipt, session.id, pad(++receiptSeq)),
                agentId: context.id,
              });
          },
          redact: clean,
          onTraceWarning: (message) => process.stderr.write(message + "\n"),
          onPhase: (state) =>
            process.stdout.write(
              `\nWorkflow ${state.phase} · review ${state.reviewRound}\n`,
            ),
        });
      }
      let compactionFailure: string | undefined;
      const turnAbort = controller;
      const result = await withSessionCalls(
        { home, id: session.id, limits: project.limits, abort: controller },
        async (budget) => {
          const value = await workflow!.run(
            {
              provider: router.provider(model!),
              sessionId: session.id,
              async prepareContext(history, route, _signal, context) {
                const prepared = await prepareProviderHistory(history, {
                  provider: route.provider,
                  model: route.model,
                  signal: _signal,
                  system: context?.system ?? system,
                  tools:
                    context?.tools ?? [...tools.values()].map((t) => t.spec),
                  checkpoint,
                  skipCompaction: !!compactionFailure,
                  limit: route.provider
                    .models()
                    .find((m) => m.id === route.model)?.contextTokens,
                  threshold: project.context.compactThreshold,
                  overhead:
                    estimateTokens({
                      system: context?.system ?? system,
                      tools:
                        context?.tools ??
                        [...tools.values()].map((t) => t.spec),
                    }) + 4096,
                });
                if (prepared.compacted && prepared.checkpoint) {
                  checkpoint = prepared.checkpoint;
                  await checkpointFile().write(checkpoint);
                }
                if (prepared.failure && !compactionFailure) {
                  compactionFailure = prepared.failure;
                  process.stdout.write(
                    `\nAuto-compaction skipped (${route.model}): ${clean(prepared.failure)}\n`,
                  );
                }
                return {
                  messages: prepared.messages,
                  ...(!prepared.fits ? { stop: "context_overflow" } : {}),
                };
              },
              router,
              current: () => ({ model: model!, reasoning: { effort } }),
              onFallback: (route) => {
                model = route.model;
                process.stdout.write(`\n↻ fallback: ${model}\n`);
              },
              reasoning: { effort },
              model: model!,
              system,
              messages,
              tools,
              redact: clean,
              checkpoint: fileCheckpoint,
              permission: (call, signal) => ask(call, signal),
              onEvent(event) {
                if (event.type === "text_delta") {
                  bufferedText += event.text;
                  const boundary = Math.max(
                    bufferedText.lastIndexOf(" "),
                    bufferedText.lastIndexOf("\n"),
                    bufferedText.lastIndexOf("\t"),
                  );
                  if (boundary >= 0) {
                    process.stdout.write(
                      clean(bufferedText.slice(0, boundary + 1)),
                    );
                    bufferedText = bufferedText.slice(boundary + 1);
                  }
                } else if (event.type === "message_done") {
                  process.stdout.write(clean(bufferedText));
                  bufferedText = "";
                } else if (event.type === "step")
                  process.stdout.write(`\n[${event.round} ${event.step}] `);
                else if (event.type === "error")
                  process.stdout.write(clean(event.error.message));
                else if (event.type === "rate_limited")
                  process.stdout.write(
                    `Rate limited; wait ${event.retryAfterSec ?? "unknown"} seconds`,
                  );
              },
            },
            turnAbort.signal,
          );
          return { ...value, stopCause: budget.stopCause ?? value.stopCause };
        },
      );
      messages = result.messages;
      await receiptStore.append(
        session.id,
        [
          ...childReceipts.splice(0),
          ...result.receipts.map((r) =>
            toReceipt(r, session.id, pad(++receiptSeq)),
          ),
        ],
        clean,
      );
      await sessions.append(session.id, messages.slice(persisted), clean);
      persisted = messages.length;
      session = { ...session, model, effort, updatedAt: Date.now() };
      await sessions.save(session);
      if (bufferedText) process.stdout.write(clean(bufferedText));
      controller = undefined;
      process.stdout.write(
        `\n[stopped: ${result.stopCause}; receipts: ${result.receipts.length}]\n`,
      );
    }
  } finally {
    controller?.abort();
    await mcp?.close();
    rl.close();
    process.removeListener("SIGINT", interrupt);
  }
  if (resumeNext) {
    const next = args.filter(
      (_, i) =>
        !["--resume", "--cwd", "--model", "--effort"].includes(args[i]!) &&
        !["--resume", "--cwd", "--model", "--effort"].includes(args[i - 1]!),
    );
    await headless([...next, "--resume", resumeNext]);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  headless().catch(() => {
    process.stderr.write(
      "Headless failed; check workspace, credentials and installed tools\n",
    );
    process.exitCode = 1;
  });
}
