import { projectHookApproval } from "./main/hooks/shell-hooks.js";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
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
import { webTools } from "./main/tools/web.js";
import {
  readReceiptReplay,
  compareReplayPermissions,
} from "./main/session/replay.js";

export async function headless(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    process.stdout.write(
      "XHarness Phase 6\nnode dist/headless.js [--model provider:model] [--cwd path] [--resume id] [--fake [--fixtures dir]]\nnode dist/headless.js --replay sessionId [--replay-parent parentId] [--replay-mode default|acceptEdits|plan --cwd path] [--fake]\n/model provider:model [effort] /mode default|acceptEdits|plan /phase plan|implement|review /review /compact /exit /clear · Ctrl+C interrupts a turn\n",
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
    : [new ClaudeAdapter(), new CodexAdapter()];
  const router = new Router(providers, config?.fallback, config?.aliases);
  router.provider(model);
  const access = new FileAccess(cwd);
  const tools = new Map([...fileTools(access), ...shellSearchTools(cwd)]);
  if (config?.web.enabled !== false)
    for (const [name, tool] of webTools(
      () => router.provider(model!),
      config?.web.searchMode ?? "live",
      fake,
    ))
      tools.set(name, tool);
  // --fake は通信も資格情報の読み取りも行わない。
  const secrets = fake ? [] : await readLocalSecrets();
  const clean = (text: string) => redact(text, secrets);
  let system = `You are a coding agent working in ${cwd}. Use Read before modifying existing files. Bash executes PowerShell 7 and already runs in this working directory, so do not prefix commands with cd or Set-Location. Tool dates use ISO 8601. Respect project instructions.`;
  system +=
    "\n\n" + clean(await projectMemory(home, cwd, project.context.memoryFiles));
  const workspaces = new WorkspaceStore(home);
  await workspaces.load();
  const workspaceId = resume?.workspaceId ?? (await workspaces.add(cwd));
  let session: StoredSession = resume ?? {
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
  await sessions.save(session);
  let messages: Message[] = resume ? await sessions.messages(session.id) : [];
  let persisted = messages.length;
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
  try {
    while (!closed) {
      let input: string;
      try {
        input = await rl.question("❯ ");
      } catch {
        break;
      }
      if (input.trim() === "/exit") break;
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
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        await sessions.save(session);
        process.stdout.write(`Session: ${session.id}\n`);
        access.reads.clear();
        continue;
      }
      if (input.trim() === "/compact") {
        const prepared = await prepareProviderHistory(messages, {
          provider: router.provider(model!),
          model: model!,
          system,
          tools: [...tools.values()].map((t) => t.spec),
          signal: AbortSignal.timeout(60000),
          checkpoint,
          force: true,
          threshold: project.context.compactThreshold,
        });
        checkpoint = prepared.checkpoint;
        if (checkpoint) await checkpointFile().write(checkpoint);
        process.stdout.write(
          prepared.compacted
            ? "History compacted; original retained\n"
            : "No older history to compact\n",
        );
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
      controller = new AbortController();
      let bufferedText = "";
      messages.push({
        role: "user",
        content: [{ type: "text", text: clean(input) }],
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
        if (choice === "s" && !force) sessionRules.push(grantFor(fullCall));
        if (choice === "a" && !force) {
          const grant = grantFor({
            ...fullCall,
            input: JSON.parse(clean(JSON.stringify(call.input))) as unknown,
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
              ))
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
          redact: clean,
          onPhase: (state) =>
            process.stdout.write(
              `\nWorkflow ${state.phase} · review ${state.reviewRound}\n`,
            ),
        });
      }
      const result = await workflow.run(
        {
          provider: router.provider(model),
          sessionId: session.id,
          async prepareContext(history, route, _signal, context) {
            const prepared = await prepareProviderHistory(history, {
              provider: route.provider,
              model: route.model,
              signal: _signal,
              system: context?.system ?? system,
              tools: context?.tools ?? [...tools.values()].map((t) => t.spec),
              checkpoint,
              limit: route.provider.models().find((m) => m.id === route.model)
                ?.contextTokens,
              threshold: project.context.compactThreshold,
              overhead:
                estimateTokens({
                  system: context?.system ?? system,
                  tools:
                    context?.tools ?? [...tools.values()].map((t) => t.spec),
                }) + 4096,
            });
            if (prepared.compacted && prepared.checkpoint) {
              checkpoint = prepared.checkpoint;
              await checkpointFile().write(checkpoint);
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
          model,
          system,
          messages,
          tools,
          redact: clean,
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
        controller.signal,
      );
      messages = result.messages;
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
    rl.close();
    process.removeListener("SIGINT", interrupt);
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
