import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCheckpointStore } from "./store.js";
it("preserves invalid records and links while expiring only safe, old directories", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-purge-"));
  const root = join(home, "checkpoints");
  for (const name of [
    "bad name/turn",
    "s/bad name",
    "s/broken",
    "s/expired",
    "s/invalid-date",
  ])
    await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, "s", "broken", "turn.json"), "{");
  await writeFile(
    join(root, "s", "expired", "turn.json"),
    JSON.stringify({ createdAt: 0 }),
  );
  await writeFile(
    join(root, "s", "invalid-date", "turn.json"),
    JSON.stringify({ createdAt: "0" }),
  );
  const unrelated = join(home, "outside");
  await mkdir(unrelated);
  await writeFile(
    join(unrelated, "turn.json"),
    JSON.stringify({ createdAt: 0 }),
  );
  await symlink(
    unrelated,
    join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await new FileCheckpointStore(home).purge(30, Date.now(), true);
  expect(await readdir(join(root, "s"))).toEqual([
    "bad name",
    "broken",
    "invalid-date",
  ]);
  expect(await readFile(join(unrelated, "turn.json"), "utf8")).toContain(
    "createdAt",
  );
});
it("shares the hourly sweep across instances, with an explicit startup sweep", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-purge-interval-"));
  const store = new FileCheckpointStore(home),
    now = Date.now();
  await store.purge(30, now);
  const folder = join(home, "checkpoints", "s", "old");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "turn.json"), JSON.stringify({ createdAt: 0 }));
  await new FileCheckpointStore(home).purge(30, now + 1000);
  expect(await readdir(folder)).toEqual(["turn.json"]);
  await store.purge(30, now + 3600000);
  await expect(readdir(folder)).rejects.toMatchObject({ code: "ENOENT" });
});
