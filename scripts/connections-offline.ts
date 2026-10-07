import { writeFile } from "node:fs/promises";
import { compareOfflineConnections } from "../src/main/connections/offline.js";

const report = await compareOfflineConnections();
const json = JSON.stringify(report, null, 2) + "\n";
if (process.argv[2]) await writeFile(process.argv[2], json, { flag: "wx" });
else process.stdout.write(json);
if (report.rows.some((row) => !row.passed)) process.exitCode = 1;
