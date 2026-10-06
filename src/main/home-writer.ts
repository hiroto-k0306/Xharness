import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export class HomeWriterBusy extends Error {
  constructor() {
    super(
      "同じ保存先を使用中、またはロックの所有者を確認できません。起動中のアプリを終了してから再試行してください。",
    );
  }
}
function dead(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
type Owner = { pid: number; token: string };
async function owner(path: string): Promise<Owner | undefined> {
  try {
    const value = JSON.parse(await readFile(join(path, "owner.json"), "utf8"));
    if (
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.token === "string"
    )
      return value;
  } catch {
    /* Missing/partial ownership is never evidence of a dead process. */
  }
  return undefined;
}

/** Desktop and headless share this lock; PID reuse conservatively refuses reclamation. */
export async function acquireHomeWriter(home: string) {
  await mkdir(resolve(home), { recursive: true });
  const root = await realpath(resolve(home));
  const path = join(root, ".writer-lock");
  const remove = async (target: string) => {
    if (
      dirname(resolve(target)) !== root ||
      ![path, path + ".recovery"].includes(target)
    )
      throw new Error("Invalid lock cleanup path");
    await rm(target, { recursive: true });
  };
  const claim = { pid: process.pid, token: randomUUID() };
  const create = async () => {
    await mkdir(path);
    const file = await open(join(path, "owner.json"), "wx");
    try {
      await file.writeFile(JSON.stringify(claim));
      await file.sync();
    } finally {
      await file.close();
    }
  };
  try {
    await create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Serialize stale cleanup. An abandoned recovery guard needs manual inspection.
    const guard = path + ".recovery";
    try {
      await mkdir(guard);
    } catch {
      throw new HomeWriterBusy();
    }
    try {
      const previous = await owner(path);
      if (!previous || !dead(previous.pid)) throw new HomeWriterBusy();
      await remove(path);
      try {
        await create();
      } catch {
        throw new HomeWriterBusy();
      }
    } finally {
      await remove(guard);
    }
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const current = await owner(path);
      if (current?.pid === claim.pid && current.token === claim.token)
        await remove(path);
    },
  };
}
