import { loadClaudeAuth } from "../lib/oauth.js";
import { probeTool } from "./tool.js";
import { readFile } from "node:fs/promises";
import { type SseEvent } from "../lib/sse.js";

try {
  if (process.argv[2] && process.argv[2] !== "--resume-first")
    throw new Error();
  const saved =
    process.argv[2] === "--resume-first"
      ? (JSON.parse(
          await readFile("test/fixtures/claude/c3-tool-1.json", "utf8"),
        ) as {
          status: number;
          events: SseEvent[];
          body?: unknown;
        })
      : undefined;
  const result = await probeTool(await loadClaudeAuth(), {
    first: saved ? { ...saved, ok: saved.status === 200 } : undefined,
  });
  console.log(JSON.stringify(result.report, null, 2));
  if (!result.success) process.exitCode = 1;
} catch {
  console.error("Claude tool probe failed; inspect masked local recordings");
  process.exitCode = 1;
}
