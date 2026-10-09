import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { headless, type HeadlessPorts } from "./headless.js";
import { SessionStore } from "./main/session/store.js";
import {
  loadCatalog,
  overrideCatalogForTest,
  resolveModelPolicy,
} from "./main/config/catalog.js";
import type { OfficialSessionSubmission } from "./shared/official-session.js";

const shipped = structuredClone(loadCatalog());
const homes: string[] = [];
function restrictHaikuEffort() {
  const next = structuredClone(shipped);
  next.models.find((m) => m.alias === "haiku")!.efforts = { high: "high" };
  overrideCatalogForTest(next);
}
afterEach(async () => {
  overrideCatalogForTest(undefined);
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "xh-headless-alias-"));
  homes.push(home);
  const dispatch = vi.fn(async (id: string) => id);
  const view = () => ({
    available: true,
    storageReady: true,
    simulated: true,
    records: [],
  });
  const service = {
    submitSession: vi.fn(async (request: OfficialSessionSubmission) => {
      const model = resolveModelPolicy(request.model, request.effort);
      await dispatch(model.id);
      return {
        workflowId: "offline",
        status: "completed",
        summary: "accepted reference",
      };
    }),
    command: vi.fn(async () => view()),
    view,
    close: vi.fn(async () => {}),
  } satisfies NonNullable<HeadlessPorts["service"]>;
  const terminal = (commands: string[]) => {
    const input = new PassThrough();
    let output = "",
      error = "";
    const out = new Writable({
      write(chunk, _encoding, done) {
        const text = chunk.toString();
        output += text;
        if (text === "❯ " && commands.length)
          queueMicrotask(() => input.write(commands.shift()! + "\n"));
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
      interactive: false,
      result: () => ({ output, error }),
    };
  };
  const save = async (legacy = false) => {
    const store = new SessionStore(home);
    await store.load();
    const cwd = join(home, "saved-project");
    await mkdir(cwd);
    await store.save({
      id: "saved",
      workspaceId: null,
      cwd,
      model: legacy ? "fake" : "claude:opus",
      effort: "high",
      readOnly: false,
      title: "saved history",
      createdAt: 10,
      updatedAt: 20,
      providers: [],
    });
    await store.append(
      "saved",
      [
        { role: "user", content: [{ type: "text", text: "earlier request" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "earlier answer from concrete-old-id" },
          ],
          ...(legacy
            ? {}
            : {
                meta: {
                  officialWorkflow: {
                    id: "older-official",
                    status: "completed",
                  },
                },
              }),
        },
      ],
      (text) => text,
    );
    return readFile(join(home, "sessions", "saved.jsonl"), "utf8");
  };
  return { home, service, dispatch, terminal, save };
}

it.each(["unknown", "unsupported effort"])(
  "resumes saved official history despite an unrelated invalid default: %s",
  async (reason) => {
    const f = await fixture();
    const history = await f.save();
    if (reason === "unsupported effort") restrictHaikuEffort();
    await writeFile(
      join(f.home, "config.yaml"),
      reason === "unknown"
        ? "main: {model: claude:unknown, effort: high}\n"
        : "main: {model: claude:haiku, effort: max}\n",
    );
    const io = f.terminal(["follow up", "/exit"]);
    expect(
      await headless(["--fake", "--resume", "saved"], {
        ...io,
        home: f.home,
        service: f.service,
      }),
      JSON.stringify(io.result()),
    ).toBe(0);
    expect(f.service.submitSession).toHaveBeenCalledOnce();
    expect(f.service.submitSession.mock.calls[0]![0]).toMatchObject({
      model: "claude:opus",
      effort: "high",
    });
    expect(
      (
        await readFile(join(f.home, "sessions", "saved.jsonl"), "utf8")
      ).startsWith(history),
    ).toBe(true);
    const store = new SessionStore(f.home);
    await store.load();
    expect(store.get("saved")?.model).toBe("claude:opus");
  },
);

it("opens legacy history read-only with an invalid default and does not dispatch", async () => {
  const f = await fixture();
  const before = await f.save(true);
  await writeFile(
    join(f.home, "config.yaml"),
    "main: {model: claude:unknown, effort: max}\n",
  );
  const io = f.terminal(["/exit"]);
  expect(
    await headless(["--fake", "--resume", "saved"], {
      ...io,
      home: f.home,
      service: f.service,
    }),
  ).toBe(0);
  expect(io.result().output).toContain("旧会話は閲覧専用");
  expect(await readFile(join(f.home, "sessions", "saved.jsonl"), "utf8")).toBe(
    before,
  );
  expect(f.service.submitSession).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it("exports legacy history with invalid defaults without model initialization or history changes", async () => {
  const f = await fixture();
  const before = await f.save(true);
  await writeFile(
    join(f.home, "config.yaml"),
    "main: {model: claude:unknown, effort: max}\n",
  );
  const io = f.terminal([]);
  const report = join(f.home, "saved.html");
  expect(
    await headless(["--fake", "--report", "saved", "--output", report], {
      ...io,
      home: f.home,
      service: f.service,
    }),
  ).toBe(0);
  expect(await readFile(report, "utf8")).toContain(
    "earlier answer from concrete-old-id",
  );
  expect(await readFile(join(f.home, "sessions", "saved.jsonl"), "utf8")).toBe(
    before,
  );
  expect(f.service.submitSession).not.toHaveBeenCalled();
  expect(f.service.close).not.toHaveBeenCalled();
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(["unknown", "unsupported effort"])(
  "refuses a fresh invalid selection before service dispatch: %s",
  async (reason) => {
    const f = await fixture();
    if (reason === "unsupported effort") restrictHaikuEffort();
    const io = f.terminal(["must not send", "/exit"]);
    const args =
      reason === "unknown"
        ? ["--model", "claude:unknown"]
        : ["--model", "claude:haiku", "--effort", "max"];
    await expect(
      headless(["--fake", ...args], {
        ...io,
        home: f.home,
        service: f.service,
      }),
    ).rejects.toThrow();
    expect(f.service.submitSession).not.toHaveBeenCalled();
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);
