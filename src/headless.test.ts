import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { headless, type HeadlessPorts } from "./headless.js";
import { SessionStore } from "./main/session/store.js";
import type { OfficialSessionSubmission } from "./shared/official-session.js";
import type {
  OfficialWorkflowCommand,
  OfficialWorkflowView,
} from "./shared/official-workflow.js";
import type { WorkflowRecord } from "./main/workflow/official/runtime.js";
import { fixturePlan } from "./main/workflow/official/fixtures.js";
import { Terminal } from "./headless/terminal.js";

async function home() {
  return mkdtemp(join(tmpdir(), "xh-native-headless-"));
}
function terminal(
  commands: string[],
  interactive = false,
  onWrite?: (text: string, input: PassThrough) => void,
) {
  const input = new PassThrough();
  let output = "";
  let error = "";
  const out = new Writable({
    write(chunk, _encoding, done) {
      const text = chunk.toString();
      output += text;
      onWrite?.(text, input);
      if (
        (text === "❯ " || text.includes("承認しますか？")) &&
        commands.length
      ) {
        const next = commands.shift()!;
        queueMicrotask(() => input.write(next + "\n"));
      }
      done();
    },
  });
  const err = new Writable({
    write(chunk, _encoding, done) {
      error += chunk.toString();
      done();
    },
  });
  return {
    input,
    output: out,
    error: err,
    interactive,
    result: () => ({ output, error }),
  };
}
function mockService(cwd: string, approvals = false) {
  const id = "11111111-1111-4111-8111-111111111111";
  const record: WorkflowRecord = {
    version: 1,
    simulated: true,
    id,
    cwd,
    goal: "test",
    startedAt: new Date().toISOString(),
    status: "planning",
    next: "complete",
    base: "0".repeat(40),
    head: "0".repeat(40),
    correctionRounds: 0,
    calls: [],
    tools: [],
    checks: [],
    reviews: [],
    commits: [],
    plan: fixturePlan(),
  };
  let view: OfficialWorkflowView = {
    available: true,
    storageReady: true,
    simulated: true,
    records: [],
  };
  let finish: (() => void) | undefined;
  const command = vi.fn(async (command: OfficialWorkflowCommand) => {
    if (command.action === "approve") {
      view.approval = undefined;
      record.status = "implementing";
      view.operationApproval = {
        workflowId: id,
        approvalId: "22222222-2222-4222-8222-222222222222",
        digest: "b".repeat(64),
        requestId: "33333333-3333-4333-8333-333333333333",
        sessionId: "session",
        turnId: "turn",
        itemId: "task",
        command: "node --test",
        cwd,
        targets: ["add.mjs"],
        reason: "Independent test",
        expiresAt: Date.now() + 60000,
      };
    }
    if (command.action === "tool_decision" && command.allow) {
      view.operationApproval = undefined;
      record.status = "completed";
      finish?.();
    }
    if (command.action === "tool_decision" && !command.allow) {
      view.operationApproval = undefined;
      record.status = "failed";
      finish?.();
    }
    if (command.action === "cancel") {
      record.status = "cancelled";
      view.approval = undefined;
      view.operationApproval = undefined;
      finish?.();
    }
    return structuredClone(view);
  });
  const submitSession = vi.fn(
    async (request: OfficialSessionSubmission, signal: AbortSignal) => {
      record.sessionId = request.sessionId;
      view = {
        ...view,
        activeId: id,
        records: [{ record, resumeBlocked: null, reportHref: "" }],
        ...(approvals ? { approval: { id, digest: "a".repeat(64) } } : {}),
      };
      await new Promise<void>((resolve) => {
        finish = resolve;
        signal.addEventListener(
          "abort",
          () => {
            record.status = "cancelled";
            resolve();
          },
          { once: true },
        );
        if (!approvals) {
          record.status = "completed";
          resolve();
        }
        if (signal.aborted) {
          record.status = "cancelled";
          resolve();
        }
      });
      view.activeId = undefined;
      return {
        workflowId: id,
        summary: "native answer",
        status: record.status,
        intent: approvals ? ("work" as const) : ("question" as const),
      };
    },
  );
  return {
    submitSession,
    command,
    view: () => structuredClone(view),
    close: vi.fn(async () => {
      finish?.();
    }),
  } satisfies NonNullable<HeadlessPorts["service"]>;
}

it("uses the real shared official service in fake mode and preserves native history on resume", async () => {
  const root = await home();
  const first = terminal(["hello", "/exit"]);
  const firstCode = await headless(["--fake", "--model", "codex:sol"], {
    ...first,
    home: root,
  });
  expect(firstCode, JSON.stringify(first.result())).toBe(0);
  expect(first.result().output).toContain("模擬回答");
  const store = new SessionStore(root);
  await store.load();
  const saved = store.list()[0]!;
  const history = await readFile(
    join(root, "sessions", saved.id + ".jsonl"),
    "utf8",
  );
  expect(history).toContain("officialWorkflow");
  expect(history).toContain("hello");
  expect(
    (await readdir(join(root, "official-workflows"))).some((name) =>
      /^[a-f0-9-]{36}$/.test(name),
    ),
  ).toBe(true);
  const second = terminal(["follow up", "/exit"]);
  expect(
    await headless(["--fake", "--resume", saved.id], { ...second, home: root }),
  ).toBe(0);
  const resumed = await readFile(
    join(root, "sessions", saved.id + ".jsonl"),
    "utf8",
  );
  expect(resumed.startsWith(history)).toBe(true);
  expect(resumed).toContain("follow up");
  await store.load();
  expect(store.get(saved.id)?.model).toBe(saved.model);
}, 10000);

it("passes the selected model/cwd to the common controller and requests explicit plan and operation consent", async () => {
  const root = await home(),
    cwd = await home();
  const service = mockService(cwd, true);
  const io = terminal(["fix arithmetic", "y", "y", "/exit"], true);
  const code = await headless(
    ["--fake", "--cwd", cwd, "--model", "codex:sol", "--effort", "high"],
    { ...io, home: root, service },
  );
  expect(code, JSON.stringify(io.result())).toBe(0);
  expect(service.submitSession).toHaveBeenCalledOnce();
  expect(service.submitSession.mock.calls[0]![0]).toMatchObject({
    cwd,
    model: "codex:gpt-6.1-sol",
    effort: "high",
    automaticWork: true,
    autoOperations: false,
  });
  expect(service.command.mock.calls.map(([c]) => c)).toEqual([
    expect.objectContaining({ action: "approve", digest: "a".repeat(64) }),
    expect.objectContaining({
      action: "tool_decision",
      digest: "b".repeat(64),
      allow: true,
    }),
  ]);
  expect(io.result().output).toContain("Independent test");
  expect(io.result().output).toContain("native answer");
});

it("refuses non-TTY consent even when piped input contains y", async () => {
  const root = await home(),
    cwd = await home();
  const service = mockService(cwd, true);
  const io = terminal(["fix arithmetic", "y", "/exit"]);
  expect(
    await headless(["--fake", "--cwd", cwd], { ...io, home: root, service }),
  ).toBe(1);
  expect(io.result().error).toContain("非TTY");
  expect(service.command).toHaveBeenCalledWith(
    expect.objectContaining({ action: "cancel" }),
  );
  expect(
    service.command.mock.calls.some(
      ([c]) => c.action === "approve" || c.action === "tool_decision",
    ),
  ).toBe(false);
});

it("records an explicit operation refusal through the same decision endpoint as the GUI", async () => {
  const root = await home(),
    cwd = await home();
  const service = mockService(cwd, true);
  const io = terminal(["fix arithmetic", "y", "n", "/exit"], true);
  expect(
    await headless(["--fake", "--cwd", cwd], { ...io, home: root, service }),
  ).toBe(1);
  expect(service.command.mock.calls.map(([c]) => c)).toEqual([
    expect.objectContaining({ action: "approve" }),
    expect.objectContaining({ action: "tool_decision", allow: false }),
  ]);
});

it("cancels pending work on stdin EOF and releases the shared home lock", async () => {
  const root = await home(),
    cwd = await home();
  const service = mockService(cwd, true);
  let ended = false;
  const io = terminal(["fix arithmetic"], true, (text, input) => {
    if (text.startsWith("workflow ") && !ended) {
      ended = true;
      queueMicrotask(() => input.end());
    }
  });
  expect(
    await headless(["--fake", "--cwd", cwd], { ...io, home: root, service }),
  ).toBe(130);
  expect(service.submitSession.mock.calls[0]![1].aborted).toBe(true);
  const next = terminal(["/exit"]);
  expect(
    await headless(["--fake"], {
      ...next,
      home: root,
      service: mockService(cwd),
    }),
  ).toBe(0);
});

it("cancels a running request on Ctrl+C without retry or HTTP fallback", async () => {
  const root = await home(),
    cwd = await home();
  const service = mockService(cwd, true);
  let stopped = false;
  const io = terminal(["fix arithmetic", "/exit"], true, (text) => {
    if (text.startsWith("workflow ") && !stopped) {
      stopped = true;
      queueMicrotask(() => process.emit("SIGINT"));
    }
  });
  expect(
    await headless(["--fake", "--cwd", cwd], { ...io, home: root, service }),
  ).toBe(130);
  expect(service.submitSession).toHaveBeenCalledOnce();
  expect(service.submitSession.mock.calls[0]![1].aborted).toBe(true);
});

it("keeps legacy sessions readable and unchanged while blocking legacy execution/settings", async () => {
  const root = await home(),
    cwd = await home();
  const store = new SessionStore(root);
  await store.load();
  await store.save({
    id: "legacy",
    title: "saved",
    cwd,
    workspaceId: null,
    readOnly: false,
    model: "fake",
    effort: "high",
    createdAt: 1,
    updatedAt: 1,
    providers: [],
  });
  await store.append(
    "legacy",
    [
      { role: "user", content: [{ type: "text", text: "legacy request" }] },
      { role: "assistant", content: [{ type: "text", text: "legacy answer" }] },
    ],
    (s) => s,
  );
  const original = await readFile(
    join(root, "sessions", "legacy.jsonl"),
    "utf8",
  );
  const service = mockService(cwd);
  const io = terminal([
    "/history",
    "/model codex:sol high",
    "continue",
    "/exit",
  ]);
  expect(
    await headless(["--fake", "--resume", "legacy"], {
      ...io,
      home: root,
      service,
    }),
  ).toBe(1);
  expect(io.result().output).toContain("legacy answer");
  expect(io.result().output).toContain("閲覧専用");
  expect(service.submitSession).not.toHaveBeenCalled();
  expect(await readFile(join(root, "sessions", "legacy.jsonl"), "utf8")).toBe(
    original,
  );
  await store.load();
  expect(store.get("legacy")?.model).toBe("fake");
  await expect(
    headless(["--fake", "--resume", "legacy", "--model", "codex:sol"], {
      home: root,
    }),
  ).rejects.toThrow("保存済み");
});

it("rejects legacy slash commands instead of invoking old tools", async () => {
  const root = await home();
  const service = mockService(root);
  const io = terminal(["/compact", "/mcp", "/review", "/init", "/exit"]);
  expect(await headless(["--fake"], { ...io, home: root, service })).toBe(1);
  expect(io.result().error).toContain("非対応");
  expect(service.submitSession).not.toHaveBeenCalled();
  await expect(
    headless(["--fake", "--fixtures", "old-fixtures"], { home: root }),
  ).rejects.toThrow("未対応");
});

it("reports a failed native dispatch once and preserves the failed request", async () => {
  const root = await home();
  const service = mockService(root);
  service.submitSession.mockRejectedValue(
    new Error("native connection unavailable"),
  );
  const io = terminal(["question", "/exit"]);
  expect(await headless(["--fake"], { ...io, home: root, service })).toBe(1);
  expect(io.result().error).toContain("native connection unavailable");
  expect(service.submitSession).toHaveBeenCalledOnce();
  const store = new SessionStore(root);
  await store.load();
  expect(
    (await store.messages(store.list()[0]!.id))[0]?.content,
  ).toContainEqual({ type: "text", text: "question" });
});

it("keeps report/replay export read-only and never creates a runtime", async () => {
  const root = await home();
  const service = mockService(root);
  const io = terminal(["question", "/exit"]);
  await headless(["--fake"], { ...io, home: root, service });
  const store = new SessionStore(root);
  await store.load();
  const id = store.list()[0]!.id;
  const original = await readFile(
    join(root, "sessions", id + ".jsonl"),
    "utf8",
  );
  const read = terminal([]);
  expect(
    await headless(
      ["--fake", "--report", id, "--output", join(root, "report.html")],
      { ...read, home: root, service },
    ),
  ).toBe(0);
  expect(await readFile(join(root, "report.html"), "utf8")).toContain(
    "native answer",
  );
  expect(
    await headless(["--fake", "--replay", id], {
      ...read,
      home: root,
      service,
    }),
  ).toBe(0);
  expect(service.submitSession).toHaveBeenCalledOnce();
  expect(await readFile(join(root, "sessions", id + ".jsonl"), "utf8")).toBe(
    original,
  );
  read.input.destroy();
});

it("cancels a pending terminal read and removes its abort listener", async () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const terminal = new Terminal(input, output, true);
  const controller = new AbortController();
  const read = terminal.read("approval", controller.signal);
  controller.abort();
  expect(await read).toBeUndefined();
  input.write("next\n");
  expect(await terminal.read("prompt")).toBe("next");
  terminal.close();
});

it("handles /stop immediately while native work is running", async () => {
  const root = await home(),
    cwd = await home();
  const service = mockService(cwd, true);
  let stopped = false;
  const io = terminal(["fix arithmetic", "/exit"], true, (text, input) => {
    if (text.startsWith("workflow ") && !stopped) {
      stopped = true;
      queueMicrotask(() => input.write("/stop\n"));
    }
  });
  expect(
    await headless(["--fake", "--cwd", cwd], { ...io, home: root, service }),
  ).toBe(130);
  expect(service.submitSession).toHaveBeenCalledOnce();
  expect(service.submitSession.mock.calls[0]![1].aborted).toBe(true);
});

it("releases a terminal approval prompt when the service withdraws the request", async () => {
  const root = await home(),
    cwd = await home();
  const service = mockService(cwd, true);
  let requests = 0;
  const io = terminal(["fix arithmetic"], true, (text, input) => {
    if (text === "❯ " && ++requests === 2) queueMicrotask(() => input.end());
    if (text.includes("承認しますか？"))
      setTimeout(() => {
        void service.command({
          action: "cancel",
          id: "11111111-1111-4111-8111-111111111111",
        });
      }, 5);
  });
  expect(
    await headless(["--fake", "--cwd", cwd], { ...io, home: root, service }),
  ).toBe(1);
  expect(service.command.mock.calls.some(([c]) => c.action === "approve")).toBe(
    false,
  );
});

it("releases the writer lock even when a native service fails during shutdown", async () => {
  const root = await home();
  const service = mockService(root);
  service.close.mockRejectedValue(new Error("close failed"));
  const io = terminal(["/exit"]);
  await expect(
    headless(["--fake"], { ...io, home: root, service }),
  ).rejects.toThrow("close failed");
  const next = terminal(["/exit"]);
  expect(
    await headless(["--fake"], {
      ...next,
      home: root,
      service: mockService(root),
    }),
  ).toBe(0);
});
