import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAcceptance } from "./workspace.js";
import { spawnOwnedProcess } from "./owned-process.js";
it.skipIf(process.platform !== "win32")(
  "preserves bidirectional stdio without parsing or logging native messages",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-owned-stdio-"));
    const child = spawnOwnedProcess(
      process.execPath,
      [
        "-e",
        "process.stdin.once('data',b=>{process.stdout.write(b);process.stdin.pause();process.exit(0)})",
      ],
      { cwd },
    );
    let output = "";
    child.stdout.on("data", (b) => (output += b));
    child.stderr.resume();
    try {
      child.stdin.write('{"method":"fixture/no-provider","id":1}\n');
      const code = await new Promise((r) => child.once("close", r));
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({
        method: "fixture/no-provider",
        id: 1,
      });
    } finally {
      child.kill();
      await rm(cwd, { recursive: true, force: true, maxRetries: 10 });
    }
  },
  30000,
);

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "xh-owned-job-"));
  await writeFile(
    join(cwd, "grandchild.mjs"),
    `import {writeFileSync} from 'node:fs';
writeFileSync('ready', String(process.pid));
setInterval(()=>writeFileSync('heartbeat',String(Date.now())),30);`,
  );
  await writeFile(
    join(cwd, "parent.mjs"),
    `import {spawn} from 'node:child_process';
spawn(process.execPath,['grandchild.mjs'],{detached:true,stdio:'ignore'});
setInterval(()=>{},100);`,
  );
  return cwd;
}
async function waitReady(cwd: string) {
  for (let i = 0; i < 200; i++) {
    try {
      return Number(await readFile(join(cwd, "ready"), "utf8"));
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("Contained fixture did not start");
}
async function stopped(cwd: string, pid: number) {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Owned descendant remained in ${cwd}`);
}
it.skipIf(process.platform !== "win32")(
  "cancellation and timeout stop a detached grandchild",
  async () => {
    for (const cancellation of [true, false]) {
      const cwd = await fixture(),
        controller = new AbortController();
      try {
        const done = runAcceptance(
          cwd,
          {
            id: "tree",
            program: process.execPath,
            args: ["parent.mjs"],
            command: "node parent.mjs",
            timeoutMs: cancellation ? 20000 : 3500,
          },
          controller.signal,
          (s) => s,
        );
        const pid = await waitReady(cwd);
        if (cancellation) controller.abort();
        const evidence = await done;
        expect(evidence.passed).toBe(false);
        await stopped(cwd, pid);
      } finally {
        controller.abort();
        await rm(cwd, { recursive: true, force: true, maxRetries: 10 });
      }
    }
  },
  30000,
);
it.skipIf(process.platform !== "win32")(
  "abrupt owner loss kills its tree without replaying or killing persisted PIDs",
  async () => {
    const cwd = await fixture();
    const module = pathToFileURL(
      resolve("src/main/workflow/official/owned-process.ts"),
    ).href;
    const parent = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `import {spawnOwnedProcess} from ${JSON.stringify(module)};
spawnOwnedProcess(process.execPath,['parent.mjs'],{cwd:${JSON.stringify(cwd)}});
setInterval(()=>{},100);`,
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    try {
      const pid = await waitReady(cwd);
      parent.kill("SIGKILL");
      await stopped(cwd, pid);
    } finally {
      parent.kill("SIGKILL");
      await rm(cwd, { recursive: true, force: true, maxRetries: 10 });
    }
  },
  30000,
);
it.skipIf(process.platform !== "win32")(
  "normal parent exit also removes an orphaned descendant and preserves quoting",
  async () => {
    const cwd = await fixture();
    try {
      const program = `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['grandchild.mjs'],{detached:true,stdio:'ignore'});
setTimeout(()=>{console.log(JSON.stringify(process.argv.slice(1)));process.exit(0)},500);`;
      const child = spawnOwnedProcess(
        process.execPath,
        ["--input-type=module", "-e", program, 'spaces "quotes" trailing\\'],
        { cwd },
      );
      let output = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.resume();
      const pid = await waitReady(cwd);
      const code = await new Promise((r) => child.once("close", r));
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual(['spaces "quotes" trailing\\']);
      await stopped(cwd, pid);
    } finally {
      await rm(cwd, { recursive: true, force: true, maxRetries: 10 });
    }
  },
  30000,
);
