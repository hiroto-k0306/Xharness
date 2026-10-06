import { dirname, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { runOfflineEvaluation } from "../src/main/session/evaluation-offline.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: pnpm evaluation:offline new-directory");
const home = resolve(output);
await mkdir(dirname(home), { recursive: true });
await mkdir(home); // Refuse an existing directory; preserve all previous evidence.
const entries = await runOfflineEvaluation(home);
const expected = entries.every(
  (e) => e.assessment?.passed === (e.configuration === "reference"),
);
if (!expected) throw new Error("Offline evaluation acceptance regression");
process.stdout.write(
  "3 fixed tasks × 2 synthetic configurations; reference passed and shorter incomplete runs rejected. No provider/network calls.\n",
);
