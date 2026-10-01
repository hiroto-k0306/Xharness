import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";

// Atomic numbered reservations persist across runs. Transport failures count too.
export async function reserveRequest(
  provider: "claude" | "codex",
  name: string,
  root = ".",
): Promise<number> {
  const limit = provider === "claude" ? 20 : 25;
  const directory = resolve(root, "spike", ".out", "budget", provider);
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
  throw new Error("Phase 0 request budget exhausted");
}
