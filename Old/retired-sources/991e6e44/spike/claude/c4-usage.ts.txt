import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectHeaders } from "../lib/headers.js";

try {
  // Use the corrected C2 recording; no new request or credential read is needed.
  const recording = JSON.parse(
    await readFile(resolve("test/fixtures/claude/c2-haiku-none.json"), "utf8"),
  ) as { responseHeaders: { all: Record<string, string> } };
  console.log(
    JSON.stringify(
      inspectHeaders(new Headers(recording.responseHeaders.all)).usage,
      null,
      2,
    ),
  );
} catch {
  console.error("Claude usage recording unavailable; run C2 first");
  process.exitCode = 1;
}
