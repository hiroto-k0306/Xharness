import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, commandApproval } from "./command-approval.js";
import type { AgentRequest } from "./contracts.js";
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "xh-approval-"));
  await writeFile(join(cwd, "add.mjs"), "synthetic");
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const request = () =>
  ({
    requestId: "11111111-1111-4111-8111-111111111111",
    cwd,
    files: ["add.mjs"],
    tests: [{ command: "node --test add.test.mjs" }],
  }) as AgentRequest;
const params = (command: string) => ({
  command,
  cwd,
  threadId: "thread",
  turnId: "turn",
  itemId: "item",
});
it("separates registered tests and a concrete scoped operation", async () => {
  expect(
    await commandApproval(request(), params("node --test add.test.mjs")),
  ).toBe("test");
  expect(
    await commandApproval(
      request(),
      params("Get-Content -LiteralPath 'add.mjs' -Raw"),
    ),
  ).toMatchObject({ targets: ["add.mjs"], sessionId: "thread" });
});
it.each([
  "Get-Content ../outside",
  "Get-Content .env",
  "Get-Content *",
  "Get-Content add.mjs; whoami",
  "Get-Content $(whoami)",
  "Get-Content add.mjs | Invoke-Expression",
  "Get-Content add.mjs > outside",
  "git status",
  "npm install",
  "pwsh -EncodedCommand abc",
  "Set-Content add.mjs code",
])(
  "rejects prohibited or unparseable operation before prompting: %s",
  async (command) => {
    expect(await commandApproval(request(), params(command))).toBeNull();
  },
);
it("rejects external permissions, wrong cwd and compound registered commands", async () => {
  expect(
    await commandApproval(request(), {
      ...params("Get-Content add.mjs"),
      additionalPermissions: {},
    }),
  ).toBeNull();
  expect(
    await commandApproval(request(), {
      ...params("Get-Content add.mjs"),
      cwd: tmpdir(),
    }),
  ).toBeNull();
  const r = request();
  r.tests[0]!.command = "node --test add.test.mjs; whoami";
  expect(await commandApproval(r, params(r.tests[0]!.command))).toBeNull();
});
it("rejects quote concatenation rather than authorizing a differently tokenized path", async () => {
  const r = request();
  r.files = ["ab"];
  await writeFile(join(cwd, "ab"), "synthetic");
  expect(await commandApproval(r, params("Get-Content 'a''b'"))).toBeNull();
  expect(await commandApproval(r, params("Get-Content a'b'"))).toBeNull();
});
it("rechecks links even for an approved lexical path", async () => {
  await rm(join(cwd, "add.mjs"));
  await symlink(join(cwd, "missing"), join(cwd, "add.mjs"), "junction");
  expect(
    await commandApproval(request(), params("Get-Content add.mjs")),
  ).toBeNull();
});
it.each([
  [{ command: ["Get-Content", "add.mjs"] }, "envelope", "command-not-string"],
  [{ cwd: undefined }, "envelope", "cwd-missing"],
  [{ cwd: tmpdir() }, "envelope", "cwd-mismatch"],
  [{ additionalPermissions: {} }, "envelope", "additional-permissions"],
  [{ networkApprovalContext: {} }, "envelope", "network-approval"],
  [{ command: "Get-Content add.mjs; whoami" }, "syntax", "not-simple"],
  [{ command: "Get-Content *" }, "syntax", "wildcard-or-nul"],
  [{ command: "Get-Content 'a''b'" }, "syntax", "quoting"],
  [{ command: "git status" }, "program", "program-not-allowed"],
  [
    { command: "pwsh.exe -NoProfile -Command Get-Content" },
    "program",
    "shell-wrapper",
  ],
  [
    { command: "Get-Content -Encoding utf8 add.mjs" },
    "target",
    "option-unsupported",
  ],
  [{ command: "Get-Content add.mjs other.mjs" }, "target", "path-count"],
  [{ command: "Get-Content other.mjs" }, "target", "not-planned-file"],
  [{ itemId: "bad id" }, "identity", "ids-invalid"],
] as const)(
  "classifies rejection %j at a fixed stage and reason",
  async (override, stage, reason) => {
    const decision = await classifyCommand(request(), {
      ...params("Get-Content add.mjs"),
      ...override,
    });
    expect(decision).toMatchObject({ kind: "rejected", stage, reason });
  },
);
it("describes a request shape without paths, arguments or secret values", async () => {
  const secret = "sk-never-persist-123";
  const decision = await classifyCommand(request(), {
    ...params(`C:/tools/pwsh.exe -Command Get-Content ${secret}`),
    commandActions: [{ type: "read", path: secret }, { type: secret }],
    availableDecisions: [
      "accept",
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: [secret] } },
      "decline",
    ],
    environmentId: null,
    kind: "command",
    surprise: secret,
  });
  expect(decision.shape).toEqual({
    fields: [
      "availableDecisions",
      "command",
      "commandActions",
      "cwd",
      "itemId",
      "kind",
      "threadId",
      "turnId",
    ],
    unknownFields: 1,
    kind: "command",
    availableDecisions: ["accept", "acceptWithExecpolicyAmendment", "decline"],
    commandType: "string",
    commandLength: expect.any(Number),
    tokenCount: 4,
    program: "pwsh.exe",
    wrapper: true,
    cwd: "same",
    commandActions: ["read", "unknown"],
    environment: null,
  });
  expect(JSON.stringify(decision.shape)).not.toContain("never-persist");
});
const B = "\\";
const PS = [
  "C:",
  "Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
];
const wrap = (inner: string, separator = B + B) =>
  `"${PS.join(separator)}" -Command '${inner}'`;
it.each([B + B, B])(
  "unwraps only the exact Codex Windows PowerShell form into a per-operation request (separator %j)",
  async (separator) => {
    const command = wrap("Get-Content -Raw add.mjs", separator);
    const decision = await classifyCommand(request(), {
      ...params(command),
      proposedExecpolicyAmendment: ["Get-Content"],
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["x"] } },
        "decline",
      ],
    });
    expect(decision).toMatchObject({
      kind: "operation",
      operation: { command, cwd, targets: ["add.mjs"] },
    });
  },
);
it("asks once for a wrapped registered test instead of preapproving it", async () => {
  const r = request();
  r.tests = [
    {
      id: "arithmetic",
      program: "node",
      args: ["--test", "add.test.mjs"],
      command: "node --test add.test.mjs",
      timeoutMs: 1000,
    },
  ];
  const command = wrap("node --test add.test.mjs");
  expect(await classifyCommand(r, params(command))).toMatchObject({
    kind: "operation",
    operation: { command, targets: ["add.test.mjs"] },
  });
  expect(await commandApproval(r, params("node --test add.test.mjs"))).toBe(
    "test",
  );
});
it("rejects when the client cannot answer with a one-time accept", async () => {
  expect(
    await classifyCommand(request(), {
      ...params(wrap("Get-Content add.mjs")),
      availableDecisions: ["acceptForSession", "decline"],
    }),
  ).toMatchObject({ stage: "envelope", reason: "accept-unavailable" });
});
it.each([
  [
    "pwsh instead of Windows PowerShell",
    `"C:${B}Program${B}pwsh.exe" -Command 'Get-Content add.mjs'`,
  ],
  [
    "extra option",
    wrap("Get-Content add.mjs").replace(" -Command", " -NoLogo -Command"),
  ],
  [
    "options in another order",
    wrap("Get-Content add.mjs").replace(" -Command", " -Command -NoProfile"),
  ],
  [
    "repeated option",
    wrap("Get-Content add.mjs").replace(
      " -Command",
      " -NoProfile -NoProfile -Command",
    ),
  ],
  [
    "lower-case NoProfile",
    wrap("Get-Content add.mjs").replace(" -Command", " -noprofile -Command"),
  ],
  [
    "lower-case option",
    wrap("Get-Content add.mjs").replace("-Command", "-command"),
  ],
  ["encoded command", `"${PS.join(B + B)}" -EncodedCommand 'abc'`],
  ["bare executable", "powershell.exe -Command 'Get-Content add.mjs'"],
  ["trailing argument", wrap("Get-Content add.mjs") + " extra"],
  ["unterminated", wrap("Get-Content add.mjs").slice(0, -1)],
  [
    "mixed separators",
    `"C:${B}Windows${B + B}System32${B}WindowsPowerShell${B}v1.0${B}powershell.exe" -Command 'Get-Content add.mjs'`,
  ],
  ["inner quote", wrap(`Get-Content "add.mjs"`)],
  ["inner expansion", wrap("Get-Content $env:USERPROFILE")],
  ["inner backtick", wrap("Get-Content add`.mjs")],
  ["inner newline", wrap("Get-Content add.mjs\nwhoami")],
  ["empty inner", wrap(" ")],
])("rejects an ambiguous wrapper: %s", async (_label, command) => {
  expect(await commandApproval(request(), params(command))).toBeNull();
});
it.each([
  [wrap("Get-Content add.mjs; whoami"), "syntax", "not-simple"],
  [wrap("Get-Content add.mjs | Out-File x"), "syntax", "not-simple"],
  [wrap("Get-Content other.mjs"), "target", "not-planned-file"],
  [wrap("Get-Content ../outside"), "target", "not-planned-file"],
  [wrap("Set-Content add.mjs x"), "program", "program-not-allowed"],
  [wrap("node --test other.test.mjs"), "program", "program-not-allowed"],
] as const)(
  "applies the unwrapped grammar to the inner command: %s",
  async (command, stage, reason) => {
    expect(await classifyCommand(request(), params(command))).toMatchObject({
      kind: "rejected",
      stage,
      reason,
    });
  },
);
it.each([
  ["local-1", "local-1"],
  ["wss://remote.example/exec", "other"],
])(
  "records only a short environment identifier (%s) and still rejects it",
  async (environmentId, recorded) => {
    const decision = await classifyCommand(request(), {
      ...params("Get-Content add.mjs"),
      environmentId,
    });
    expect(decision).toMatchObject({
      kind: "rejected",
      stage: "envelope",
      reason: "environment",
      shape: { environment: recorded },
    });
  },
);
it.each([
  [true, "local", "operation"],
  [true, "wss://remote.example/exec", "rejected"],
  [false, "local", "rejected"],
] as const)(
  "accepts an environment id only when the thread selected no environment (local-only %s, id %s)",
  async (localEnvironmentOnly, environmentId, kind) => {
    const decision = await classifyCommand(
      request(),
      { ...params("Get-Content add.mjs"), environmentId },
      { localEnvironmentOnly },
    );
    expect(decision.kind).toBe(kind);
    if (kind === "rejected")
      expect(decision).toMatchObject({
        stage: "envelope",
        reason: "environment",
      });
  },
);

it.each([B + B, B])(
  "also unwraps the exact -NoProfile -Command form into a per-operation request (separator %j)",
  async (separator) => {
    const command = wrap("Get-Content -Raw add.mjs", separator).replace(
      " -Command",
      " -NoProfile -Command",
    );
    expect(await classifyCommand(request(), params(command))).toMatchObject({
      kind: "operation",
      operation: { command, cwd, targets: ["add.mjs"] },
    });
    expect(
      await classifyCommand(
        request(),
        params(
          wrap("Get-Content add.mjs; whoami", separator).replace(
            " -Command",
            " -NoProfile -Command",
          ),
        ),
      ),
    ).toMatchObject({
      kind: "rejected",
      stage: "syntax",
      reason: "not-simple",
    });
  },
);
