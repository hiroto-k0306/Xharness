import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { toolFailure } from "./errors.js";
import { runProcess } from "./process.js";

it("reports missing programs without echoing process arguments or exception messages", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-missing-cli-"));
  vi.stubEnv("PATH", cwd);
  try {
    for (const name of ["rg", "pwsh"]) {
      await expect(
        runProcess(
          name,
          ["synthetic-sensitive-argument"],
          cwd,
          new AbortController().signal,
          1000,
        ),
      ).rejects.toThrow(
        name === "rg"
          ? "ripgrep（rg）が見つかりません"
          : "PowerShell 7（pwsh）が見つかりません",
      );
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
it.each(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "UNKNOWN"])(
  "maps %s to a fixed diagnostic",
  (code) => {
    expect(
      toolFailure({ code, message: "synthetic-sensitive-value" }),
    ).not.toContain("synthetic-sensitive-value");
    expect(toolFailure({ code })).not.toBe("Tool execution failed");
  },
);
