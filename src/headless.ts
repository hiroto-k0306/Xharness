import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { runTurn } from "./main/core/loop.js";
import { type Message } from "./main/core/types.js";
import { redact } from "./main/core/redact.js";
import { readLocalSecrets } from "./main/auth/local-secrets.js";
import { FakeProvider } from "./main/providers/fake/fake-provider.js";
import { ClaudeAdapter } from "./main/providers/claude/adapter.js";
import { FileAccess, fileTools } from "./main/tools/files.js";
import { shellSearchTools } from "./main/tools/shell-search.js";

export async function headless(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    process.stdout.write(
      "XHarness Phase 1\nnode dist/headless.js [--model claude-haiku-4-5] [--cwd path] [--fake]\n/exit /clear · Ctrl+C interrupts a turn · Every tool requires y approval\n",
    );
    return;
  }
  const option = (name: string, fallback: string) => {
    const index = args.indexOf(name);
    return index < 0 ? fallback : (args[index + 1] ?? fallback);
  };
  const cwd = resolve(option("--cwd", process.cwd()));
  const fake = args.includes("--fake");
  const model = fake ? "fake" : option("--model", "claude-haiku-4-5");
  if (
    !fake &&
    ![
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
    ].includes(model)
  )
    throw new Error("Unsupported Phase 1 model");
  const access = new FileAccess(cwd);
  const tools = new Map([...fileTools(access), ...shellSearchTools(cwd)]);
  // --fake は通信も資格情報の読み取りも行わない。
  const secrets = fake ? [] : await readLocalSecrets();
  const clean = (text: string) => redact(text, secrets);
  let system = `You are a coding agent working in ${cwd}. Use Read before modifying existing files. Bash executes PowerShell 7. Tool dates use ISO 8601. Respect project instructions.`;
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      system +=
        `\n\n${name}:\n` + clean(await readFile(resolve(cwd, name), "utf8"));
    } catch {
      /* Optional project instructions. */
    }
  }
  let messages: Message[] = [];
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY,
  });
  let controller: AbortController | undefined;
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
    `XHarness · ${model} · ${cwd}\nTools require approval. /exit to quit, /clear to reset.\n`,
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
      if (input.trim() === "/clear") {
        messages = [];
        access.reads.clear();
        continue;
      }
      if (!input.trim()) continue;
      controller = new AbortController();
      let bufferedText = "";
      messages.push({
        role: "user",
        content: [{ type: "text", text: clean(input) }],
      });
      const result = await runTurn(
        {
          provider: fake ? new FakeProvider() : new ClaudeAdapter(),
          model,
          system,
          messages,
          tools,
          redact: clean,
          async permission(call, signal) {
            const answer = await rl.question(
              `\nAllow ${clean(call.name + " " + JSON.stringify(call.input))}? [y/N] `,
              { signal },
            );
            return answer.trim().toLowerCase() === "y";
          },
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
