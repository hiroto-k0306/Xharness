import { mkdtemp, mkdir, writeFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { shellSearchTools } from "./shell-search.js";
import { diagnoseEnvironment } from "./environment.js";
import { SearchMatcher } from "./search-matcher.js";

it("diagnoses missing CLIs and folder access without recording PATH or leaving probe files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-environment-"));
  vi.stubEnv("PATH", cwd);
  try {
    const result = await diagnoseEnvironment(cwd);
    expect(result.cli).toEqual({ rg: false, pwsh: false, git: false });
    expect(result.workspace).toEqual({
      exists: true,
      readable: true,
      writable: true,
    });
    expect(result.warnings).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain(cwd);
    expect(await readdir(cwd)).toEqual([]);
    expect(
      (await diagnoseEnvironment(join(cwd, "missing"))).workspace.exists,
    ).toBe(false);
    expect(
      await shellSearchTools(cwd)
        .get("Bash")!
        .execute({ command: "echo test" }, new AbortController().signal),
    ).toMatchObject({ isError: true, error: { kind: "missing_cli" } });
  } finally {
    vi.unstubAllEnvs();
  }
});
it("falls back without rg, honors nested ignore/negation and skips secrets and binary files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-node-search-"));
  await mkdir(join(cwd, "src"));
  await mkdir(join(cwd, "ignored"));
  await writeFile(join(cwd, ".gitignore"), "ignored/\n*.txt\n!keep.txt\n");
  await writeFile(join(cwd, "src", ".gitignore"), "!child.txt\n");
  for (const path of [
    "keep.txt",
    "skip.txt",
    "src/child.txt",
    "src/skip.txt",
    "ignored/a.ts",
    "auth.json",
    ".env",
    "secret.key",
    "id_rsa",
  ])
    await writeFile(join(cwd, path), "needle");
  await writeFile(join(cwd, "binary.ts"), Buffer.from([0, 110, 101]));
  vi.stubEnv("PATH", cwd);
  try {
    const tools = shellSearchTools(cwd);
    const signal = new AbortController().signal;
    const grep = await tools
      .get("Grep")!
      .execute({ pattern: "needle" }, signal);
    expect(grep.isError).toBe(false);
    const output = JSON.parse(grep.content);
    expect(output.engine).toBe("node");
    expect(output.output).toContain("keep.txt:1:needle");
    expect(output.output).toContain("child.txt:1:needle");
    expect(output.output).not.toMatch(
      /skip|ignored|auth.json|secret.key|id_rsa/,
    );
    const glob = JSON.parse(
      (await tools.get("Glob")!.execute({ pattern: "**/*.txt" }, signal))
        .content,
    );
    expect(glob.output).toContain("keep.txt");
    expect(glob.output).toContain("child.txt");
    expect(glob.output).not.toContain("skip.txt");
    expect(
      (await tools.get("Grep")!.execute({ pattern: "[" }, signal)).error?.kind,
    ).toBe("invalid_args");
    expect(
      (
        await tools
          .get("Grep")!
          .execute({ pattern: "x", path: "missing" }, signal)
      ).error?.kind,
    ).toBe("not_found");
    expect(
      (await tools.get("Grep")!.execute({ pattern: "absent" }, signal)).isError,
    ).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});
it("caps matches at 250 and cancels even a costly regex in the worker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-node-limit-"));
  await writeFile(join(cwd, "many.ts"), "needle\n".repeat(300));
  vi.stubEnv("PATH", cwd);
  try {
    const result = await shellSearchTools(cwd)
      .get("Grep")!
      .execute({ pattern: "needle" }, new AbortController().signal);
    const output = JSON.parse(result.content).output as string;
    expect(
      output.split("\n").filter((s) => s.includes(":needle")),
    ).toHaveLength(250);
    expect(output).toContain("250件");
  } finally {
    vi.unstubAllEnvs();
  }
  const matcher = new SearchMatcher("(a+)+$");
  const abort = new AbortController();
  const pending = expect(
    matcher.match(["a".repeat(100000) + "!"], 1, abort.signal, 1000),
  ).rejects.toMatchObject({ kind: "aborted" });
  abort.abort();
  await pending;
  await matcher.close();
  const timeout = new SearchMatcher("(a+)+$");
  try {
    await expect(
      timeout.match(
        ["a".repeat(100000) + "!"],
        1,
        new AbortController().signal,
        30,
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
  } finally {
    await timeout.close();
  }
});
it("does not follow a symlink to an unapproved tree", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "xh-node-link-"));
  const outside = await mkdtemp(join(tmpdir(), "xh-node-outside-"));
  await writeFile(join(outside, "secret.txt"), "needle");
  await symlink(outside, join(cwd, "linked"), "junction");
  vi.stubEnv("PATH", cwd);
  try {
    const tool = shellSearchTools(cwd).get("Grep")!;
    expect(
      JSON.parse(
        (
          await tool.execute(
            { pattern: "needle" },
            new AbortController().signal,
          )
        ).content,
      ).output,
    ).toBe("");
    expect(
      (
        await tool.execute(
          { pattern: "needle", path: "linked" },
          new AbortController().signal,
        )
      ).error?.kind,
    ).toBe("denied");
  } finally {
    vi.unstubAllEnvs();
  }
});
