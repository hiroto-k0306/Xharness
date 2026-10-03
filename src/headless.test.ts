import { readTraceReplay } from "./main/session/report-trace.js";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { SessionStore } from "./main/session/store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
it("expands user commands once and handles init, cost and model locally", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-headless-commands-"));
  const cwd = await mkdtemp(join(tmpdir(), "xh-headless-command-ws-"));
  await mkdir(join(home, "commands"));
  await writeFile(join(home, "commands", "task.md"), "/clear\n依頼 $ARGUMENTS");
  const output = await repl(
    home,
    ["/init", "/init", "/model", "/task $&", "/cost", "/exit"],
    ["--cwd", cwd],
  );
  expect(output).toContain("上書きしません");
  expect(output).toContain("模擬通信：今ターン 1、セッション 1");
  expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toContain(
    "作業ルール",
  );
  const id = /session ([\w-]+)/.exec(output)![1]!;
  const store = new SessionStore(home);
  await store.load();
  expect(store.list()).toHaveLength(1);
  expect((await store.messages(id))[0]?.content).toContainEqual({
    type: "text",
    text: "/clear\n依頼 $&",
  });
}, 30000);
it("resumes a selected session with its own cwd and keeps both histories", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-headless-resume-command-"));
  const first = await mkdtemp(join(tmpdir(), "xh-headless-first-"));
  const second = await mkdtemp(join(tmpdir(), "xh-headless-second-"));
  const store = new SessionStore(home);
  await store.load();
  await store.save({
    id: "existing",
    title: "saved",
    cwd: second,
    workspaceId: null,
    readOnly: false,
    model: "fake",
    effort: "high",
    createdAt: 0,
    updatedAt: 0,
    providers: [],
  });
  const output = await repl(
    home,
    ["/resume", "/resume existing", "/mode plan", "/init", "/exit"],
    ["--cwd", first],
  );
  expect(output).toContain("existing · saved");
  expect(output).toContain(`${second} · session existing`);
  expect(output).toContain("planモードでは");
  await store.load();
  expect(store.list()).toHaveLength(2);
  await expect(readFile(join(second, "AGENTS.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
}, 30000);
it("waits for input after the session budget is exhausted and keeps the cap across restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-headless-budget-"));
  await writeFile(
    join(home, "config.yaml"),
    "limits: {llmCallsPerSession: 1}\n",
  );
  const output = await repl(home, ["first", "second", "/exit"]);
  expect(output).toContain("budget_exceeded");
  const id = /session ([\w-]+)/.exec(output)![1]!;
  const calls = JSON.parse(
    await readFile(join(home, "sessions", id + ".llm-calls.json"), "utf8"),
  );
  expect(calls.session).toBe(1);
  const resumed = await repl(home, ["third", "/exit"], ["--resume", id]);
  expect(resumed).toContain("budget_exceeded");
  expect(
    JSON.parse(
      await readFile(join(home, "sessions", id + ".llm-calls.json"), "utf8"),
    ).session,
  ).toBe(1);
}, 30000);

function repl(
  home: string,
  commands: string[],
  extra: string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "src/headless.ts", "--fake", ...extra],
      {
        cwd: process.cwd(),
        windowsHide: true,
        env: { ...process.env, XHARNESS_HOME: home },
      },
    );
    let output = "",
      pending = "",
      error = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Headless fixture timed out"));
    }, 15000);
    child.stdout.on("data", (bytes: Buffer) => {
      const chunk = bytes.toString();
      output += chunk;
      pending += chunk;
      if (
        (pending.endsWith("❯ ") ||
          pending.endsWith("既定code] ") ||
          pending.endsWith("確認して復元しますか？ [y/N] ")) &&
        commands.length
      ) {
        pending = "";
        child.stdin.write(commands.shift()! + "\n");
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      error += bytes.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new Error(error || "Headless fixture failed"));
    });
  });
}
it("handles rewind confirmation locally in the fake REPL and retains original JSONL", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-headless-rewind-"));
  const output = await repl(home, [
    "hello",
    "/undo",
    "conversation",
    "y",
    "/exit",
  ]);
  const id = /session ([\w-]+)/.exec(output)![1]!;
  expect(output).toContain("確認して復元");
  expect(output).toContain("復元0件、除外0件");
  const history = await readFile(join(home, "sessions", id + ".jsonl"), "utf8");
  expect(history).toContain("hello");
  expect(history).toContain('"rewind":{"keep":0}');
  const trace = (await readTraceReplay(home, id, (s) => s))!;
  expect(
    trace.records.filter((r) => r.kind === "llm" && r.phase === "start"),
  ).toHaveLength(1);
});
it("persists and resumes the fake REPL with compact checkpoints and session mode", async () => {
  const home = await mkdtemp(join(tmpdir(), "xh-headless-phase4-"));
  const output = await repl(home, [
    "first",
    "second",
    "third",
    "/compact",
    "/mode plan",
    "/exit",
  ]);
  const id = /session ([\w-]+)/.exec(output)?.[1];
  expect(id).toBeTruthy();
  const history = await readFile(join(home, "sessions", `${id}.jsonl`), "utf8");
  expect(history.trim().split("\n")).toHaveLength(6);
  expect(output).toContain("History compacted");
  const trace = (await readTraceReplay(home, id!, (s) => s))!;
  expect(
    trace.records.filter((r) => r.kind === "llm" && r.phase === "start"),
  ).toHaveLength(3);
  expect(
    trace.records.filter((r) => r.kind === "llm").every((r) => r.simulated),
  ).toBe(true);
  const checkpoint = JSON.parse(
    await readFile(join(home, "context", `${id}.json`), "utf8"),
  );
  expect(checkpoint.covered).toBe(2);
  expect(
    JSON.parse(await readFile(join(home, "sessions", "index.json"), "utf8"))[0]
      .permissionMode,
  ).toBe("plan");
  const resumed = await repl(home, ["fourth", "/exit"], ["--resume", id!]);
  expect(resumed).toContain(`session ${id}`);
  const resumedTrace = (await readTraceReplay(home, id!, (s) => s))!;
  expect(
    resumedTrace.records.filter((r) => r.kind === "llm" && r.phase === "start"),
  ).toHaveLength(4);
  expect(resumedTrace.records.at(-1)!.sequence).toBeGreaterThan(
    trace.records.at(-1)!.sequence,
  );
  expect(
    await readFile(join(home, "sessions", `${id}.jsonl`), "utf8"),
  ).toContain(history);
}, 30000);
