import { probeCliRefresh } from "./lib/cli-refresh.js";

try {
  const [provider, executable] = process.argv.slice(2);
  if ((provider !== "claude" && provider !== "codex") || !executable)
    throw new Error("Invalid CLI arguments");
  const result = await probeCliRefresh(provider, executable);
  console.log(JSON.stringify(result, null, 2));
  if (result.exitCode !== 0 || !result.pong) process.exitCode = 1;
} catch {
  console.error("CLI refresh probe failed; no credential values printed");
  process.exitCode = 1;
}
