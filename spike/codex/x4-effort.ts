import { loadCodexAuth } from "../lib/oauth.js";
import { probeEffort, spikeModels, spikeEfforts } from "./effort.js";

try {
  const [model, effort] = process.argv.slice(2);
  if (
    !model ||
    !effort ||
    !spikeModels.includes(model) ||
    !spikeEfforts.includes(effort)
  )
    throw new Error("Expected a supported model and effort");
  const result = await probeEffort(await loadCodexAuth(), model, effort);
  console.log(JSON.stringify(result.report, null, 2));
  if (!result.success) process.exitCode = 1;
} catch {
  console.error("Codex effort probe failed; inspect masked local recordings");
  process.exitCode = 1;
}
