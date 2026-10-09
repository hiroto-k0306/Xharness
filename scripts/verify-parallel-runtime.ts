import { createValidationRuntime } from "../src/main/workflow/official/validation-runtime.js";

const usage =
  "Usage: node --import tsx scripts/verify-parallel-runtime.ts --codex-path <existing absolute CLI path> [--node-path <existing absolute Node path>]\nChecks synthetic runtime isolation only; no model/thread, project code, installation, login or configuration commands.";
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--help") {
  console.log(usage);
} else {
  const values = new Map<string, string>();
  let valid = args.length > 0;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (
      !["--codex-path", "--node-path"].includes(key) ||
      !value ||
      values.has(key)
    ) {
      valid = false;
      break;
    }
    values.set(key, value);
  }
  if (!valid || !values.has("--codex-path")) {
    console.error(usage);
    process.exitCode = 2;
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const result = await createValidationRuntime({
        executable: values.get("--codex-path")!,
        nodeExecutable: values.get("--node-path") ?? process.execPath,
        signal: controller.signal,
      });
      console.log(
        JSON.stringify({
          available: result.available,
          reason: result.available ? "validated-runtime" : result.reason,
          modelDispatched: false,
        }),
      );
      process.exitCode = controller.signal.aborted
        ? 130
        : result.available
          ? 0
          : 2;
    } catch {
      console.error("validation-cleanup-or-runtime-unconfirmed");
      process.exitCode = controller.signal.aborted ? 130 : 3;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
}
