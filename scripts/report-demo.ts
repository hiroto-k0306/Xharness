import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runReportDemo } from "../src/main/session/report-demo.js";
import { exportExecutionReport } from "../src/main/session/report.js";

const output = process.argv[2];
if (!output) throw new Error("Usage: pnpm report:demo <new-file.html>");
const home = resolve(".out", `report-demo-${randomUUID()}`);
await mkdir(home, { recursive: true });
const { id } = await runReportDemo(home);
await exportExecutionReport(home, id, resolve(output));
process.stdout.write(
  `実通信なしのデモを出力しました: ${resolve(output)}\n記録: ${join(home, "traces", `${id}.jsonl`)}\n`,
);
