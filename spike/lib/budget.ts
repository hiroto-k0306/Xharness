import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

// Atomic numbered reservations persist across runs. Transport failures count too.
export async function reserveRequest(
  provider: "claude" | "codex",
  name: string,
  root = ".",
  /** 試験ごとの予算(既定は Phase 0 の共通予算) */
  options: { bucket?: string; limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? (provider === "claude" ? 20 : 25);
  if (options.bucket !== undefined && !/^[a-z0-9-]+$/.test(options.bucket))
    throw new Error("Invalid budget bucket");
  const directory = resolve(
    root,
    "spike",
    ".out",
    options.bucket ? `budget-${options.bucket}` : "budget",
    provider,
  );
  await mkdir(directory, { recursive: true });
  for (let count = 1; count <= limit; count++) {
    const path = join(directory, `${count}.json`);
    let file;
    try {
      file = await open(path, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Error("Request budget unavailable");
    }
    try {
      await file.writeFile(
        JSON.stringify({ name, reservedAt: new Date().toISOString() }) + "\n",
      );
    } finally {
      await file.close();
    }
    return count;
  }
  throw new Error(
    options.bucket
      ? `Request budget for ${options.bucket} exhausted`
      : "Phase 0 request budget exhausted",
  );
}
