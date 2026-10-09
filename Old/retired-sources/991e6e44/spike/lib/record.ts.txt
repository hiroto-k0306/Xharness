import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { inspectHeaders } from "./headers.js";
import { isSensitiveKey, maskSecrets } from "./mask.js";

export interface Recording {
  requestHeaders?: Headers;
  requestBody?: unknown;
  responseHeaders: Headers;
  status: number;
  events: unknown;
  body?: unknown;
}

export async function record(
  provider: "claude" | "codex",
  name: string,
  recording: Recording,
  options: { root?: string; secrets?: readonly string[] } = {},
): Promise<{ local: string; fixture: string }> {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name))
    throw new Error("Invalid recording name");
  if (provider !== "claude" && provider !== "codex")
    throw new Error("Invalid provider");
  const secrets = [...(options.secrets ?? [])];
  // Header credentials are also scrubbed from echoed response bodies.
  for (const headers of [recording.requestHeaders, recording.responseHeaders]) {
    if (!headers) continue;
    for (const [key, value] of headers) {
      if (isSensitiveKey(key)) {
        secrets.push(value);
        if (/^Bearer /i.test(value)) secrets.push(value.slice(7));
      }
    }
  }
  const safe = maskSecrets(
    {
      status: recording.status,
      requestHeaders: inspectHeaders(
        recording.requestHeaders ?? new Headers(),
        secrets,
      ).all,
      requestBody: recording.requestBody,
      responseHeaders: inspectHeaders(recording.responseHeaders, secrets),
      events: recording.events,
      body: recording.body,
    },
    secrets,
  );
  const root = resolve(options.root ?? ".");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const local = join(
    root,
    "spike",
    ".out",
    stamp + "-" + provider + "-" + name + ".json",
  );
  const fixture = join(root, "test", "fixtures", provider, name + ".json");
  await mkdir(join(root, "spike", ".out"), { recursive: true });
  await mkdir(join(root, "test", "fixtures", provider), { recursive: true });
  const json = JSON.stringify(safe, null, 2) + "\n";
  // AGENTS.md forbids persisting tokens, even in ignored local recordings.
  await writeFile(local, json, { encoding: "utf8", flag: "wx" });
  await writeFile(fixture, json, "utf8");
  return { local, fixture };
}
