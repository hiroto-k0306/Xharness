import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore, WorkspaceStore, type StoredSession } from "./store.js";

const session = (id: string): StoredSession => ({
  id,
  title: id,
  workspaceId: null,
  cwd: "/",
  readOnly: false,
  model: "m",
  effort: "high",
  createdAt: 0,
  updatedAt: 0,
  providers: [],
});

describe("index files survive concurrent writes and corruption", () => {
  it("saves many sessions at once without failures or lost entries", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-store-"));
    const store = new SessionStore(home);
    await store.load();
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => store.save(session(`s${i}`))),
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const onDisk = JSON.parse(
      await readFile(join(home, "sessions", "index.json"), "utf8"),
    ) as StoredSession[];
    expect(onDisk.map((s) => s.id).sort()).toEqual(
      Array.from({ length: 20 }, (_, i) => `s${i}`).sort(),
    );
    // 一時ファイルが残らない
    expect(
      (await readdir(join(home, "sessions"))).filter((f) => f.endsWith(".tmp")),
    ).toEqual([]);
  });
  it("keeps the last state when saves of different stores interleave", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-store-"));
    const ws = new WorkspaceStore(home);
    await ws.load();
    await Promise.all([
      ws.add(join(home, "a")),
      ws.add(join(home, "b")),
      ws.add(join(home, "c")),
    ]);
    const again = new WorkspaceStore(home);
    await again.load();
    expect((await again.summaries()).map((w) => w.name).sort()).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
  it("moves a corrupt index aside instead of overwriting it, and warns once", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-store-"));
    await mkdir(join(home, "sessions"), { recursive: true });
    const broken = '[{"id":"keep-me", "title": "trunc';
    await writeFile(join(home, "sessions", "index.json"), broken);
    const store = new SessionStore(home);
    await store.load();
    expect(store.list()).toEqual([]);
    expect(store.warnings).toHaveLength(1);
    expect(store.warnings[0]).toContain("退避");
    await store.save(session("new"));
    const files = await readdir(join(home, "sessions"));
    const backup = files.find((f) => f.startsWith("index.json.corrupt-"));
    expect(backup).toBeTruthy();
    expect(await readFile(join(home, "sessions", backup!), "utf8")).toBe(
      broken,
    );
  });
  it("treats a valid JSON value of the wrong shape as corrupt", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-store-"));
    await writeFile(join(home, "workspaces.json"), '{"not":"an array"}');
    const ws = new WorkspaceStore(home);
    await ws.load();
    expect(await ws.summaries()).toEqual([]);
    expect(ws.warnings).toHaveLength(1);
  });
  it("starts empty without a warning when the file does not exist yet", async () => {
    const store = new SessionStore(await mkdtemp(join(tmpdir(), "xh-store-")));
    await store.load();
    expect(store.list()).toEqual([]);
    expect(store.warnings).toEqual([]);
  });
});

describe("git state cache", () => {
  it("reuses the branch for a short time and refreshes after it expires", async () => {
    const home = await mkdtemp(join(tmpdir(), "xh-git-"));
    const repo = join(home, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    let now = 1_000_000;
    const ws = new WorkspaceStore(home, () => now);
    await ws.load();
    await ws.add(repo);
    expect((await ws.summaries())[0]).toMatchObject({
      kind: "git",
      branch: "main",
    });
    await writeFile(join(repo, ".git", "HEAD"), "ref: refs/heads/feature\n");
    now += 500;
    expect((await ws.summaries())[0]!.branch).toBe("main");
    now += 5000;
    expect((await ws.summaries())[0]!.branch).toBe("feature");
  });
});
