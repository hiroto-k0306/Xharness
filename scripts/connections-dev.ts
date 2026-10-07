import { resolve } from "node:path";
import { runDevelopmentConnection } from "../src/main/connections/development.js";
import { type ConnectionMode } from "../src/main/connections/contracts.js";
import type { SdkBinding } from "../src/main/connections/claude.js";
import type { SiwcBinding } from "../src/main/connections/openai.js";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const mode = option("--connection") as ConnectionMode;
if (!["openai-siwc", "claude-proposals", "claude-mcp"].includes(mode))
  throw new Error(
    "Specify --connection openai-siwc|claude-proposals|claude-mcp and --home isolated-directory",
  );
{
  const home = args.includes("--home") && option("--home");
  if (!home || home.startsWith("--"))
    throw new Error("Explicit isolated --home is required");
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  const fake = args.includes("--fake");
  const sdk: SdkBinding = {
    subscriptionUseConfirmed: true,
    createXServer: (handlers) => handlers,
    async *query() {
      yield {
        type: "result",
        subtype: "success",
        result: "OK",
        structured_output: { answer: "OK", actions: [] },
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
    },
  };
  const siwc: SiwcBinding = {
    registrationConfirmed: true,
    grantSource: "registered-client",
    async *send() {
      yield { type: "response.output_text.delta", delta: "OK" };
      yield {
        type: "response.completed",
        response: {
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      };
    },
  };
  const result = await runDevelopmentConnection(
    resolve(home),
    process.cwd(),
    "Reply OK.",
    { mode, ...(fake ? { simulated: true, sdk, siwc } : {}) },
    { model: "unconfigured", tools: new Map(), permission: async () => false },
    abort,
  );
  process.stdout.write(
    JSON.stringify({
      sessionId: result.sessionId,
      stopCause: result.stopCause,
      configured: fake,
      required:
        mode === "openai-siwc"
          ? "Registered SIWC client and independent authorization"
          : "Official SDK binding plus confirmation that API routes and subscription extra usage are disabled",
    }) + "\n",
  );
  if (result.stopCause !== "end_turn") process.exitCode = 1;
}
// Deliberately no environment flag that bypasses registration or billing readiness.
