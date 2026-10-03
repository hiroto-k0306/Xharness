import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  link,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { FileCheckpointStore } from "./store.js";
import { FileAccess, fileTools } from "../tools/files.js";
import { SessionStore } from "../session/store.js";
import { rewindRecord } from "../session/rewind-command.js";
import { headlessRewind } from "../session/headless-rewind.js";

let home: string, cwd: string, store: FileCheckpointStore, access: FileAccess;
const clean = (s: string) => s;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "xh-rewind-"));
  home = join(base, "home");
  cwd = join(base, "workspace");
  await mkdir(cwd);
  store = new FileCheckpointStore(home);
  access = new FileAccess(cwd);
});
async function change(path: string, content: string, messages = 0) {
  const hooks = await store.begin("s", cwd, messages, clean, vi.fn());
  const canonical = await access.path(path);
  await hooks.beforeWrite(canonical);
  await writeFile(canonical, content);
  await hooks.afterWrite(canonical, Buffer.from(content));
  return canonical;
}
it("captures once per turn through real tools and restores exact BOM/CRLF bytes", async () => {
  const original = Buffer.from("\ufeffbefore\r\n");
  await writeFile(join(cwd, "a"), original);
  const tools = fileTools(access);
  const hooks = await store.begin("s", cwd, 0, clean, vi.fn());
  for (const content of ["second", "third"]) {
    await tools.get("Read")!.execute({ path: "a" }, signal());
    expect(
      (
        await tools
          .get("Write")!
          .execute({ path: "a", content }, signal(), { checkpoint: hooks })
      ).isError,
    ).toBeFalsy();
  }
  const plan = await store.preview("s", 1);
  expect(plan.entries).toHaveLength(1);
  expect(plan.entries[0]!.conflict).toBe(false);
  expect(
    (
      await store.restore(
        plan,
        { scope: "code", includeConflicts: [] },
        signal(),
      )
    ).restored,
  ).toHaveLength(1);
  expect(await readFile(join(cwd, "a"))).toEqual(original);
});
it("removes newly created files and combines multiple turns to the earliest original", async () => {
  await writeFile(join(cwd, "a"), "original");
  await change("a", "middle", 0);
  await change("a", "latest", 2);
  await change("new", "created", 4);
  const plan = await store.preview("s", 3);
  expect(plan.messages).toBe(0);
  expect(plan.preview.files.every((f) => !f.conflict)).toBe(true);
  const result = await store.restore(
    plan,
    { scope: "both", includeConflicts: [] },
    signal(),
  );
  expect(result.restored).toHaveLength(2);
  expect(await readFile(join(cwd, "a"), "utf8")).toBe("original");
  await expect(readFile(join(cwd, "new"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("excludes external changes by default, allows explicit consent, and rechecks at restore", async () => {
  await writeFile(join(cwd, "a"), "original");
  const path = await change("a", "model");
  await writeFile(path, "external");
  const plan = await store.preview("s", 1);
  expect(plan.preview.files[0]!.conflict).toBe(true);
  expect(
    (
      await store.restore(
        plan,
        { scope: "code", includeConflicts: [] },
        signal(),
      )
    ).skipped,
  ).toEqual([path]);
  await writeFile(path, "changed during approval");
  const choice = {
    scope: "code" as const,
    includeConflicts: [plan.entries[0]!.id],
  };
  expect((await store.restore(plan, choice, signal())).skipped).toEqual([path]);
  const fresh = await store.preview("s", 1);
  await store.restore(fresh, choice, signal());
  expect(await readFile(path, "utf8")).toBe("original");
});
it("detects external changes between tracked turns", async () => {
  await writeFile(join(cwd, "a"), "original");
  const path = await change("a", "model one");
  await writeFile(path, "external");
  await change("a", "model two", 2);
  expect((await store.preview("s", 2)).preview.files[0]!.conflict).toBe(true);
});
it("skips oversized and secret content without saving their bytes", async () => {
  await writeFile(join(cwd, "big"), Buffer.alloc(10 * 1024 * 1024 + 1, 65));
  await writeFile(join(cwd, "secret"), "private-value");
  const warn = vi.fn();
  const hooks = await store.begin(
    "s",
    cwd,
    0,
    (s) => s.replaceAll("private-value", "[redacted]"),
    warn,
  );
  for (const name of ["big", "secret"])
    await hooks.beforeWrite(await access.path(name));
  expect(warn).toHaveBeenCalledTimes(2);
  const folder = (await readdir(join(store.root, "s")))[0]!;
  expect(await readdir(join(store.root, "s", folder))).toEqual(["turn.json"]);
  expect(
    await readFile(join(store.root, "s", folder, "turn.json"), "utf8"),
  ).not.toContain("private-value");
  expect(
    (await store.preview("s", 1)).preview.files.every((f) => f.unavailable),
  ).toBe(true);
});
it("refuses hard links and tampered backup data without preventing other restores", async () => {
  await writeFile(join(cwd, "a"), "original");
  const path = await change("a", "model");
  await link(path, join(cwd, "alias"));
  expect(
    (await store.preview("s", 1)).preview.files[0]!.unavailable,
  ).toBeTruthy();
  await writeFile(join(cwd, "b"), "before");
  await change("b", "after", 2);
  await change("new", "new", 4);
  const plan = await store.preview("s", 2);
  const b = plan.entries.find((e) => e.path.endsWith("b"))!;
  await writeFile(join(b.directory, b.blob!), "tampered");
  const result = await store.restore(
    plan,
    { scope: "code", includeConflicts: [] },
    signal(),
  );
  expect(result.skipped).toEqual([b.path]);
  expect(result.restored).toHaveLength(1);
  expect(await readFile(join(cwd, "b"), "utf8")).toBe("after");
});
it("never writes when backup fails and excludes all files after cancellation", async () => {
  const tools = fileTools(access);
  await expect(
    tools.get("Write")!.execute({ path: "new", content: "x" }, signal(), {
      checkpoint: {
        beforeWrite: async () => {
          throw new Error("failed");
        },
        afterWrite: async () => undefined,
      },
    }),
  ).rejects.toThrow("failed");
  await expect(readFile(join(cwd, "new"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await change("new", "x");
  const abort = new AbortController();
  abort.abort();
  expect(
    (
      await store.restore(
        await store.preview("s", 1),
        { scope: "code", includeConflicts: [] },
        abort.signal,
      )
    ).restored,
  ).toEqual([]);
  expect(await readFile(join(cwd, "new"), "utf8")).toBe("x");
});
it("purges expired backups and deletes session backups without touching workspace files", async () => {
  const path = await change("a", "x");
  await store.purge(30, Date.now() + 31 * 86400000);
  await expect(store.preview("s", 1)).rejects.toThrow();
  await change("b", "y");
  const sessions = new SessionStore(home);
  await sessions.load();
  await sessions.delete("s");
  await expect(readdir(join(store.root, "s"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(path, "utf8")).toBe("x");
  await expect(store.remove("../workspace")).rejects.toThrow();
  await expect(
    new FileCheckpointStore(cwd).begin("s", cwd, 0, clean, vi.fn()),
  ).rejects.toThrow("作業フォルダの外");
});
it("rewinds active conversation with append-only history and selects the new branch", async () => {
  const sessions = new SessionStore(home);
  const user = (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  });
  await sessions.append("s", [user("first")], clean);
  await store.begin("s", cwd, 0, clean, vi.fn());
  await sessions.append("s", [user("second")], clean);
  await store.begin("s", cwd, 1, clean, vi.fn());
  const plan = await store.preview("s", 1);
  await sessions.append(
    "s",
    [rewindRecord(plan.messages, "conversation", 0, 0)],
    clean,
  );
  await store.conversationRewound("s", plan);
  expect(
    (await sessions.messages("s")).map((m) => m.content[0]),
  ).not.toContainEqual(user("second").content[0]);
  expect(await readFile(join(home, "sessions", "s.jsonl"), "utf8")).toContain(
    "second",
  );
  await store.begin("s", cwd, 2, clean, vi.fn());
  expect((await store.preview("s", 1)).messages).toBe(2);
  expect((await store.preview("s", 2)).messages).toBe(0);
});
it("headless preview cancels without writes, then restores conversation only after confirmation", async () => {
  const sessions = new SessionStore(home);
  const path = await change("new", "keep");
  const answers = ["code", "n", "conversation", "y"];
  const question = vi.fn(async () => answers.shift()!);
  const print = vi.fn();
  const run = () =>
    headlessRewind(store, sessions, "s", 1, question, print, clean, signal());
  expect(await run()).toBeUndefined();
  expect(await sessions.messages("s")).toEqual([]);
  expect(await run()).toBe("conversation");
  expect(await readFile(path, "utf8")).toBe("keep");
  expect((await sessions.messages("s"))[0]!.meta?.rewind).toEqual({ keep: 0 });
  expect(print.mock.calls.flat().join("")).toContain("Bash");
});
it("serializes concurrent captures and preserves all manifest entries", async () => {
  const hooks = await store.begin("s", cwd, 0, clean, vi.fn());
  const a = await access.path("a"),
    b = await access.path("b");
  await Promise.all([
    hooks.beforeWrite(a),
    hooks.beforeWrite(a),
    hooks.beforeWrite(b),
  ]);
  expect((await store.preview("s", 1)).entries).toHaveLength(2);
});
it("does not follow a replaced parent directory into an unrelated folder", async () => {
  await mkdir(join(cwd, "sub"));
  await writeFile(join(cwd, "sub", "a"), "original");
  await change("sub/a", "model");
  const plan = await store.preview("s", 1);
  const other = join(home, "other");
  await mkdir(other);
  await writeFile(join(other, "a"), "unrelated");
  await rename(join(cwd, "sub"), join(cwd, "old-sub"));
  await symlink(
    other,
    join(cwd, "sub"),
    process.platform === "win32" ? "junction" : "dir",
  );
  expect(
    (
      await store.restore(
        plan,
        { scope: "code", includeConflicts: [] },
        signal(),
      )
    ).restored,
  ).toEqual([]);
  expect(await readFile(join(other, "a"), "utf8")).toBe("unrelated");
});
it("recognizes its own both-scope restore when a new conversation branch writes again", async () => {
  await writeFile(join(cwd, "a"), "original");
  await change("a", "first", 0);
  await change("a", "discarded", 2);
  const plan = await store.preview("s", 1);
  const result = await store.restore(
    plan,
    { scope: "both", includeConflicts: [] },
    signal(),
  );
  await store.conversationRewound("s", plan, result.restored);
  await change("a", "new branch", 3);
  const earlier = await store.preview("s", 2);
  expect(earlier.messages).toBe(0);
  expect(earlier.preview.files[0]!.conflict).toBe(false);
  await store.restore(
    earlier,
    { scope: "both", includeConflicts: [] },
    signal(),
  );
  expect(await readFile(join(cwd, "a"), "utf8")).toBe("original");
});
it("treats a second code-only undo as unchanged and replaces atomically without temporary files", async () => {
  await writeFile(join(cwd, "a"), "original");
  await change("a", "model");
  await store.restore(
    await store.preview("s", 1),
    { scope: "code", includeConflicts: [] },
    signal(),
  );
  const repeated = await store.preview("s", 1);
  expect(repeated.preview.files[0]!.conflict).toBe(false);
  expect(
    (
      await store.restore(
        repeated,
        { scope: "code", includeConflicts: [] },
        signal(),
      )
    ).restored,
  ).toHaveLength(1);
  expect(await readFile(join(cwd, "a"), "utf8")).toBe("original");
  expect(await readdir(cwd)).toEqual(["a"]);
});
