import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundShells } from "./background-shells.js";
import { BackgroundOutput } from "./background-output.js";
import { backgroundTools } from "./background-tools.js";
import { shellSearchTools } from "./shell-search.js";
import { cliAvailable } from "./environment.js";
import { runTurn } from "../core/loop.js";
import { FakeProvider } from "../providers/fake/fake-provider.js";
import { lifecycleTools } from "./lifecycle.js";

const signal = () => new AbortController().signal;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function finished(shells: BackgroundShells, id: string) {
  const deadline = Date.now() + 5000;
  while (true) {
    const result = await shells.output(id, signal(), 100);
    if (result.status !== "running") return result;
    if (Date.now() > deadline) throw new Error("timeout");
  }
}
it("paginates omitted output without loss, masks before slicing and caps retained bytes", () => {
  const output = new BackgroundOutput();
  output.append("H".repeat(20000) + "M".repeat(40000) + "T".repeat(20000));
  let count = 0;
  const first = output.read();
  expect(first.output.length).toBe(30000);
  expect(first.output.startsWith("H")).toBe(true);
  expect(first.output.endsWith("T")).toBe(true);
  count += first.output.replace(/\n….*?…\n/g, "").length;
  while (output.pending)
    count += output.read().output.replace(/\n….*?…\n/g, "").length;
  expect(count).toBe(80000);
  expect(output.read().output).toBe("");
  output.append("x".repeat(2000000) + "LAST");
  const retained = output.read();
  expect(retained.droppedBytes).toBe(2000004 - 1048576);
  expect(retained.output.endsWith("LAST")).toBe(true);
  expect(retained.remainingBytes).toBeLessThan(1048576);
  const masked = new BackgroundOutput();
  masked.append("x".repeat(14980) + "SECRET");
  masked.append("-VALUE" + "y".repeat(40000));
  const clean = (s: string) => s.replaceAll("SECRET-VALUE", "masked");
  let all = "";
  while (masked.pending) all += masked.read(clean).output;
  expect(all).not.toContain("SECRET");
  expect(all).not.toContain("VALUE");
});
it("returns immediately, waits for output and returns only unread text", async () => {
  const shells = new BackgroundShells();
  try {
    const started = await shells.start(
      process.execPath,
      [
        "-e",
        "setTimeout(()=>{console.log('first');setTimeout(()=>console.log('second'),100)},100)",
      ],
      process.cwd(),
      signal(),
    );
    expect(started.status).toBe("running");
    const first = await shells.output(started.shellId, signal(), 1000);
    expect(first.output).toContain("first");
    const second = await shells.output(started.shellId, signal(), 1000);
    expect(second.output).toContain("second");
    expect(second.output).not.toContain("first");
    expect((await finished(shells, started.shellId)).status).toBe("completed");
  } finally {
    await shells.endTurn();
  }
});
it("limits simultaneous shells, isolates IDs, stops and clears IDs for next turn", async () => {
  const shells = new BackgroundShells(),
    other = new BackgroundShells();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        (
          await shells.start(
            process.execPath,
            ["-e", "setTimeout(()=>{},60000)"],
            process.cwd(),
            signal(),
          )
        ).shellId,
      );
    await expect(
      shells.start(process.execPath, [], process.cwd(), signal()),
    ).rejects.toMatchObject({ kind: "invalid_args" });
    await expect(
      other.start(process.execPath, [], process.cwd(), signal()),
    ).rejects.toMatchObject({ kind: "invalid_args" });
    await expect(other.kill(ids[0]!)).rejects.toMatchObject({
      kind: "not_found",
    });
    expect((await shells.kill(ids[0]!)).status).toBe("killed");
    expect((await shells.kill(ids[0]!)).status).toBe("killed");
    const next = await shells.start(
      process.execPath,
      ["-e", "setTimeout(()=>{},60000)"],
      process.cwd(),
      signal(),
    );
    await shells.endTurn();
    await expect(shells.output(next.shellId, signal())).rejects.toMatchObject({
      kind: "not_found",
    });
  } finally {
    await shells.endTurn();
    await other.endTurn();
  }
});
it("reports timeout, failed exit and abort, cancels waiting and validates arguments", async () => {
  const shells = new BackgroundShells();
  const tools = backgroundTools(shells);
  try {
    const timed = await shells.start(
      process.execPath,
      ["-e", "setTimeout(()=>{},60000)"],
      process.cwd(),
      signal(),
      40,
    );
    expect((await finished(shells, timed.shellId)).status).toBe("timeout");
    expect(
      (
        await tools
          .get("BashOutput")!
          .execute({ shellId: timed.shellId }, signal())
      ).error?.kind,
    ).toBe("timeout");
    const bad = await shells.start(
      process.execPath,
      ["-e", "process.exit(7)"],
      process.cwd(),
      signal(),
    );
    expect(await finished(shells, bad.shellId)).toMatchObject({
      status: "failed",
      exitCode: 7,
    });
    const abort = new AbortController();
    const running = await shells.start(
      process.execPath,
      ["-e", "setTimeout(()=>{},60000)"],
      process.cwd(),
      abort.signal,
    );
    const waiting = new AbortController();
    const pending = expect(
      shells.output(running.shellId, waiting.signal, 60000),
    ).rejects.toMatchObject({ kind: "aborted" });
    waiting.abort();
    await pending;
    abort.abort();
    await sleep(100);
    expect((await shells.output(running.shellId, signal())).status).toBe(
      "aborted",
    );
    for (const input of [
      {},
      { shellId: "x", wait: "true" },
      { shellId: "x", timeoutSec: 61 },
    ])
      expect(
        (await tools.get("BashOutput")!.execute(input, signal())).error?.kind,
      ).toBe("invalid_args");
    expect(
      (await tools.get("KillShell")!.execute({ shellId: "foreign" }, signal()))
        .error?.kind,
    ).toBe("not_found");
  } finally {
    await shells.endTurn();
  }
});
const hasPwsh = await cliAvailable("pwsh");
it
  .skipIf(!hasPwsh)
  .each(["StopTask", "AskUserQuestion", "hook_error", "abort"])(
  "cleans background processes after %s",
  async (mode) => {
    const tools = new Map([
      ...shellSearchTools(process.cwd()),
      ...lifecycleTools(),
    ]);
    const abort = new AbortController();
    let id = "";
    const provider = new FakeProvider({
      script: [
        {
          type: "message",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "Bash",
                id: "b",
                input: {
                  command: "Start-Sleep -Seconds 60",
                  run_in_background: true,
                },
              },
            ],
          },
        },
        {
          type: "message",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: mode === "AskUserQuestion" ? mode : "StopTask",
                id: "stop",
                input:
                  mode === "AskUserQuestion"
                    ? { question: "続けますか？" }
                    : { reason: "stop" },
              },
            ],
          },
        },
      ],
      onRequest: (request) => {
        for (const m of request.messages)
          for (const b of m.content)
            if (b.type === "tool_result" && typeof b.content === "string")
              id = JSON.parse(b.content).shellId;
      },
    });
    const result = await runTurn(
      {
        provider,
        model: "fake",
        system: "test",
        tools,
        messages: [],
        permission: async () => true,
        afterStep: async (step, ctx) => {
          if (step === "receipt" && ctx.round === 1 && mode === "abort")
            abort.abort();
          return { kind: "continue" };
        },
        beforeStep: async (step, ctx) => {
          if (step === "model" && ctx.round === 2 && mode === "hook_error")
            throw new Error("synthetic hook failure");
          return { kind: "continue" };
        },
      },
      abort.signal,
    );
    expect(result.stopCause).toBe(
      mode === "StopTask"
        ? "agent_stopped"
        : mode === "AskUserQuestion"
          ? "awaiting_user"
          : mode === "abort"
            ? "aborted"
            : "hook_failed",
    );
    // The initial call also remains in the receipt after an abort before model round 2.
    id ||= JSON.parse(
      result.receipts.find((r) => r.tool === "Bash")!.output!,
    ).shellId;
    expect(
      (await tools.get("BashOutput")!.execute({ shellId: id }, signal())).error
        ?.kind,
    ).toBe("not_found");
  },
);
it.skipIf(!hasPwsh)(
  "Bash starts a background shell through the normal gate and closes it at turn end",
  async () => {
    const tools = shellSearchTools(process.cwd());
    let id = "";
    const provider = new FakeProvider({
      script: [
        {
          type: "message",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                name: "Bash",
                id: "b",
                input: {
                  command: "Start-Sleep -Seconds 60",
                  run_in_background: true,
                },
              },
            ],
          },
        },
        {
          type: "message",
          stopReason: "end_turn",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        },
      ],
      onRequest: (request) => {
        for (const m of request.messages)
          for (const b of m.content)
            if (b.type === "tool_result" && typeof b.content === "string")
              id = JSON.parse(b.content).shellId;
      },
    });
    let approvals = 0;
    const result = await runTurn(
      {
        provider,
        model: "fake",
        system: "test",
        messages: [],
        tools,
        permission: async () => {
          approvals++;
          return true;
        },
      },
      signal(),
    );
    expect(result.stopCause).toBe("end_turn");
    expect(approvals).toBe(1);
    expect(id).not.toBe("");
    expect(
      (await tools.get("BashOutput")!.execute({ shellId: id }, signal())).error
        ?.kind,
    ).toBe("not_found");
  },
);
it.skipIf(!hasPwsh)(
  "foreground Bash reports timeout without exposing process arguments",
  async () => {
    const tool = shellSearchTools(process.cwd()).get("Bash")!;
    expect(
      await tool.execute(
        { command: "Start-Sleep -Seconds 60", timeoutSec: 1 },
        signal(),
      ),
    ).toMatchObject({ isError: true, error: { kind: "timeout" } });
  },
);
it.skipIf(process.platform !== "win32" || !hasPwsh)(
  "Windows job kills descendants even when the PowerShell parent exits naturally",
  async () => {
    const tools = shellSearchTools(process.cwd());
    const executable = process.execPath.replaceAll("'", "''");
    let pid: number | undefined;
    try {
      const started = JSON.parse(
        (
          await tools.get("Bash")!.execute(
            {
              command: `$p = Start-Process -FilePath '${executable}' -ArgumentList @('-e','setTimeout(()=>{},60000)') -WindowStyle Hidden -PassThru; $p.Id`,
              run_in_background: true,
            },
            signal(),
          )
        ).content,
      );
      let output = "";
      const deadline = Date.now() + 5000;
      while (true) {
        const result = JSON.parse(
          (
            await tools
              .get("BashOutput")!
              .execute(
                { shellId: started.shellId, wait: true, timeoutSec: 1 },
                signal(),
              )
          ).content,
        );
        output += result.output;
        if (result.status !== "running") {
          expect(result.status).toBe("completed");
          break;
        }
        if (Date.now() > deadline) throw new Error("timeout");
      }
      pid = Number(output.trim());
      expect(pid).toBeGreaterThan(0);
      await sleep(100);
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      await tools.get("Bash")!.endTurn!();
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          /* already stopped */
        }
      }
    }
  },
);
it
  .skipIf(process.platform !== "win32" || !hasPwsh)
  .each(["natural", "kill", "abort", "endTurn"])(
  "terminates Windows children and grandchildren on %s",
  async (mode) => {
    const folder = await mkdtemp(join(tmpdir(), "xh-job-descendants-"));
    const script = join(folder, "parent.cjs"),
      ids = join(folder, "pids.json");
    await writeFile(
      script,
      `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{windowsHide:true,stdio:'ignore'}); require('node:fs').writeFileSync(${JSON.stringify(ids)},JSON.stringify([process.pid,child.pid])); setTimeout(()=>{},60000);`,
    );
    const tools = shellSearchTools(folder),
      abort = new AbortController();
    let pids: number[] = [];
    try {
      const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
      const command = `Start-Process -FilePath ${quote(process.execPath)} -ArgumentList ${quote('"' + script + '"')} -WindowStyle Hidden; while (!(Test-Path ${quote(ids)})) { Start-Sleep -Milliseconds 20 }; ${mode === "natural" ? "" : "Start-Sleep -Seconds 60"}`;
      const output = await tools
        .get("Bash")!
        .execute({ command, run_in_background: true }, abort.signal);
      expect(output.isError).toBe(false);
      const { shellId } = JSON.parse(output.content);
      await vi.waitFor(
        async () => {
          pids = JSON.parse(await readFile(ids, "utf8"));
          expect(pids).toHaveLength(2);
        },
        { timeout: 10000 },
      );
      if (mode === "kill")
        await tools.get("KillShell")!.execute({ shellId }, signal());
      if (mode === "abort") abort.abort();
      if (mode === "endTurn") await tools.get("Bash")!.endTurn!();
      if (mode === "natural") {
        await vi.waitFor(
          async () => {
            const result = JSON.parse(
              (await tools.get("BashOutput")!.execute({ shellId }, signal()))
                .content,
            );
            expect(result.status).toBe("completed");
          },
          { timeout: 10000 },
        );
      }
      await vi.waitFor(
        () => {
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        },
        { timeout: 5000 },
      );
    } finally {
      await tools.get("Bash")!.endTurn!();
      for (const pid of pids)
        try {
          process.kill(pid);
        } catch {
          /* Already exited. */
        }
    }
  },
  30000,
);
