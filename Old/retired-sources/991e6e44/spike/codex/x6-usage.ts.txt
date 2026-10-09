import { readFile } from "node:fs/promises";
import { inspectHeaders } from "../lib/headers.js";

try {
  const results = [];
  for (const model of ["gpt-6-luna", "gpt-6-1-sol", "gpt-6-astra"]) {
    const saved = JSON.parse(
      await readFile(`test/fixtures/codex/x2-${model}.json`, "utf8"),
    ) as {
      responseHeaders: { all: Record<string, string> };
    };
    results.push({
      model,
      usage: inspectHeaders(new Headers(saved.responseHeaders.all)).usage,
    });
  }
  console.log(JSON.stringify(results, null, 2));
} catch {
  console.error("Codex usage recordings unavailable; run X2 first");
  process.exitCode = 1;
}
