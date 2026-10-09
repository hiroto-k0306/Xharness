import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { FileAccess, fileTools } from "./files.js";
import { FileCheckpointStore } from "../checkpoints/store.js";
import { Changes } from "../workflow/changes.js";
import { decidePermission } from "../core/permissions.js";
import { childNeedsAsk } from "../agents/permissions.js";
const signal = () => new AbortController().signal;
const edits = [
  { old: "one\ntwo", new: "first\nsecond" },
  { old: "second", new: "last" },
];
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "xh-multi-edit-"));
  const path = join(cwd, "file.txt");
  await writeFile(path, "\ufeffone\r\ntwo\r\n");
  const tools = fileTools(new FileAccess(cwd));
  await tools.get("Read")!.execute({ path }, signal());
  return { cwd, path, tools, multi: tools.get("MultiEdit")! };
}
it("applies ordered edits once, preserves exact format, records a diff and rewinds", async () => {
  const { cwd, path, tools } = await setup();
  const store = new FileCheckpointStore(
    await mkdtemp(join(tmpdir(), "xh-multi-home-")),
  );
  const hooks = await store.begin("s", cwd, 0, (s) => s, vi.fn());
  const changes = new Changes(cwd);
  const wrapped = changes.wrap(tools);
  expect(
    (
      await wrapped
        .get("MultiEdit")!
        .execute({ path, edits }, signal(), { checkpoint: hooks })
    ).isError,
  ).toBeFalsy();
  expect(await readFile(path)).toEqual(Buffer.from("\ufefffirst\r\nlast\r\n"));
  expect(await changes.diff()).toContain("last");
  expect(await tools.get("MultiEdit")!.validate({ path, edits })).toContain(
    "Read",
  );
  const plan = await store.preview("s", 1);
  expect(plan.entries).toHaveLength(1);
  expect(plan.entries[0]?.conflict).toBe(false);
  await store.restore(plan, { scope: "code", includeConflicts: [] }, signal());
  expect(await readFile(path)).toEqual(Buffer.from("\ufeffone\r\ntwo\r\n"));
  expect((await readdir(cwd)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});
it.each(["missing", "ambiguous"])(
  "keeps every byte and never checkpoints when the final edit is %s",
  async (kind) => {
    const { path, multi } = await setup();
    const before = await readFile(path);
    const checkpoint = { beforeWrite: vi.fn(), afterWrite: vi.fn() };
    const result = await multi.execute(
      {
        path,
        edits: [
          { old: "one", new: "two" },
          { old: kind === "missing" ? "absent" : "two", new: "changed" },
        ],
      },
      signal(),
      { checkpoint },
    );
    expect(result).toMatchObject({
      isError: true,
      error: { kind: "invalid_args" },
    });
    expect(await readFile(path)).toEqual(before);
    expect(checkpoint.beforeWrite).not.toHaveBeenCalled();
    expect(checkpoint.afterWrite).not.toHaveBeenCalled();
  },
);
it("rejects invalid schemas, stale reads, credential paths and cancellation", async () => {
  const { path, multi } = await setup();
  for (const input of [
    { path, edits: [] },
    { path, edits: [{ old: "", new: "x" }] },
    { path, edits: [{ old: "one", new: "x", extra: true }] },
    { path, edits: [{ old: "one" }] },
    { path: "auth.json", edits },
  ])
    expect(await multi.validate(input)).toBeTruthy();
  const abort = new AbortController();
  abort.abort();
  await expect(multi.execute({ path, edits }, abort.signal)).rejects.toThrow();
  await writeFile(path, "external");
  expect(await multi.execute({ path, edits }, signal())).toMatchObject({
    isError: true,
  });
  expect(await readFile(path, "utf8")).toBe("external");
});
it("does not overwrite a change or proceed after cancellation during checkpoint capture", async () => {
  for (const cancel of [false, true]) {
    const { path, cwd, multi } = await setup();
    const abort = new AbortController();
    const checkpoint = {
      beforeWrite: async () => {
        if (cancel) abort.abort();
        else await writeFile(path, "external");
      },
      afterWrite: vi.fn(),
    };
    const run = multi.execute({ path, edits }, abort.signal, { checkpoint });
    if (cancel) await expect(run).rejects.toThrow();
    else expect(await run).toMatchObject({ isError: true });
    expect(await readFile(path, "utf8")).toBe(
      cancel ? "\ufeffone\r\ntwo\r\n" : "external",
    );
    expect(checkpoint.afterWrite).not.toHaveBeenCalled();
    expect((await readdir(cwd)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  }
});
it("uses Edit rules, plan/read-only denial, protected-path checks and worker file scopes", async () => {
  const { cwd } = await setup();
  const call = (path: string) => ({
    id: "m",
    name: "MultiEdit",
    input: { path, edits },
  });
  expect(
    await decidePermission(
      call("file.txt"),
      { mode: "default", rules: [] },
      cwd,
    ),
  ).toBe("ask");
  expect(
    await decidePermission(
      call("file.txt"),
      { mode: "acceptEdits", rules: [] },
      cwd,
    ),
  ).toBe("allow");
  for (const mode of ["plan", "acceptEdits"] as const)
    expect(
      await decidePermission(
        call("file.txt"),
        { mode, rules: [{ tool: "Edit", decision: "allow" }] },
        cwd,
        { readOnly: true },
      ),
    ).toBe("deny");
  expect(
    await decidePermission(
      call("file.txt"),
      { mode: "acceptEdits", rules: [{ tool: "Edit", decision: "deny" }] },
      cwd,
    ),
  ).toBe("deny");
  for (const path of ["../outside", ".git/config"])
    expect(
      await decidePermission(
        call(path),
        { mode: "acceptEdits", rules: [{ tool: "Edit", decision: "allow" }] },
        cwd,
      ),
    ).toBe("ask");
  const context = { id: "w", name: "worker", cwd, files: ["file.txt"] };
  expect(await childNeedsAsk(call("file.txt"), context)).toBe(false);
  expect(await childNeedsAsk(call("other.txt"), context)).toBe(true);
});
