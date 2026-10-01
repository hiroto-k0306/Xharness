import { loadCodexAuth } from "../lib/oauth.js";
import { probeCodexTool } from "./tool.js";

try {
  const effort = process.argv[2] ?? "high";
  if (effort !== "high" && effort !== "max")
    throw new Error("Unsupported tool effort");
  const result = await probeCodexTool(await loadCodexAuth(), { effort });
  console.log(JSON.stringify(result.report, null, 2));
  if (!result.success) process.exitCode = 1;
} catch {
  console.error("Codex tool probe failed; inspect masked local recordings");
  process.exitCode = 1;
}
