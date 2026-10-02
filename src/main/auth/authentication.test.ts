import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Authentication, credentialStatus } from "./authentication.js";
import { type AuthenticationView } from "../../shared/ipc.js";

it("reports missing, malformed, expired and available credentials without exposing or changing them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xh-auth-"));
  expect((await credentialStatus("claude", dir)).status).toBe("missing");
  const file = join(dir, ".credentials.json");
  await writeFile(file, "invalid");
  expect((await credentialStatus("claude", dir)).status).toBe("missing");
  const data = JSON.stringify({
    claudeAiOauth: { accessToken: "synthetic-credential", expiresAt: 100 },
  });
  await writeFile(file, data);
  expect(await credentialStatus("claude", dir, 101)).toEqual({
    provider: "claude",
    status: "expired",
  });
  expect(await credentialStatus("claude", dir, 99)).toEqual({
    provider: "claude",
    status: "available",
  });
  expect(await readFile(file, "utf8")).toBe(data);
  const token =
    "header." +
    Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url") +
    ".signature";
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({
      tokens: { access_token: token, account_id: "synthetic-account" },
    }),
  );
  expect(await credentialStatus("codex", dir, 1001)).toEqual({
    provider: "codex",
    status: "expired",
  });
  await writeFile(
    join(dir, "auth.json"),
    JSON.stringify({
      tokens: { access_token: "opaque", account_id: "synthetic-account" },
    }),
  );
  expect(await credentialStatus("codex", dir)).toEqual({
    provider: "codex",
    status: "available",
  });
});

function setup(approved = true) {
  let status: AuthenticationView["status"] = "expired";
  const options = {
    read: vi.fn(
      async (
        provider: AuthenticationView["provider"],
      ): Promise<AuthenticationView> => ({ provider, status }),
    ),
    confirm: vi.fn(async () => approved),
    launch: vi.fn(async () => {
      status = "available";
      return true;
    }),
    refreshSecrets: vi.fn(async () => {}),
    changed: vi.fn(),
  };
  return { auth: new Authentication(options), options };
}
it("checks startup status without launching a CLI and cancellation leaves credentials untouched", async () => {
  const { auth, options } = setup(false);
  await auth.refresh();
  const initial = auth.snapshot();
  expect(options.launch).not.toHaveBeenCalled();
  await auth.authenticate("claude");
  expect(options.confirm).toHaveBeenCalledWith("claude");
  expect(options.launch).not.toHaveBeenCalled();
  expect(auth.snapshot()).toEqual(initial);
  expect(auth.isBusy()).toBe(false);
});
it("launches only after consent, rereads credentials and refreshes masking secrets", async () => {
  const { auth, options } = setup();
  await auth.refresh();
  await auth.authenticate("codex");
  expect(options.launch).toHaveBeenCalledWith("codex");
  expect(options.confirm.mock.invocationCallOrder[0]).toBeLessThan(
    options.launch.mock.invocationCallOrder[0]!,
  );
  expect(auth.snapshot().find((v) => v.provider === "codex")?.status).toBe(
    "available",
  );
  expect(options.refreshSecrets).toHaveBeenCalledTimes(2);
  auth.reject("codex");
  expect(auth.snapshot().find((v) => v.provider === "codex")?.status).toBe(
    "rejected",
  );
});
it("prevents duplicate login and status refresh from clearing an active authorization", async () => {
  const { auth, options } = setup();
  let release!: (value: boolean) => void;
  options.confirm.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await auth.refresh();
  const first = auth.authenticate("claude");
  await vi.waitFor(() => expect(options.confirm).toHaveBeenCalledTimes(1));
  await auth.authenticate("codex");
  await auth.refresh();
  expect(auth.isBusy()).toBe(true);
  expect(auth.snapshot().find((v) => v.provider === "claude")?.status).toBe(
    "authenticating",
  );
  release(false);
  await first;
  expect(options.launch).not.toHaveBeenCalled();
});
it("never exposes CLI exceptions and permits retry after failed login", async () => {
  const { auth, options } = setup();
  await auth.refresh();
  options.launch.mockRejectedValueOnce(new Error("synthetic-sensitive-output"));
  await auth.authenticate("claude");
  expect(auth.isBusy()).toBe(false);
  expect(JSON.stringify(auth.snapshot())).not.toContain(
    "synthetic-sensitive-output",
  );
  expect(auth.snapshot().find((v) => v.provider === "claude")?.status).toBe(
    "error",
  );
  await auth.authenticate("claude");
  expect(auth.snapshot().find((v) => v.provider === "claude")?.status).toBe(
    "available",
  );
});
