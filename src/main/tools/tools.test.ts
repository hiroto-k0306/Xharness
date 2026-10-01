import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileAccess, fileTools } from "./files.js";
import { shellSearchTools } from "./shell-search.js";
import { trimOutput } from "./registry.js";
import { redact } from "../core/redact.js";

let directory: string;
const testRoot = resolve("spike/.out");
const signal = () => new AbortController().signal;
beforeEach(async () => {
  await mkdir(testRoot, { recursive: true });
  directory = await mkdtemp(join(testRoot, "phase1-test-"));
});
afterEach(async () => {
  if (!resolve(directory).startsWith(testRoot + sep + "phase1-test-"))
    throw new Error("Invalid test cleanup target");
  await rm(directory, { recursive: true, force: true });
});
describe("file tools", () => {
  it("requires Read, replaces exactly once, and emits ISO dates", async () => {
    const tools = fileTools(new FileAccess(directory));
    await writeFile(join(directory, "a.txt"), "alpha beta");
    expect(
      await tools.get("Write")!.validate({ path: "a.txt", content: "lost" }),
    ).toContain("Read");
    const read = await tools.get("Read")!.execute({ path: "a.txt" }, signal());
    const payload = JSON.parse(read.content) as { modifiedAt: string };
    expect(new Date(payload.modifiedAt).toISOString()).toBe(payload.modifiedAt);
    const edited = await tools
      .get("Edit")!
      .execute(
        { path: "a.txt", oldString: "beta", newString: "gamma" },
        signal(),
      );
    expect(edited.isError).not.toBe(true);
    expect(await readFile(join(directory, "a.txt"), "utf8")).toBe(
      "alpha gamma",
    );
    expect(
      await tools
        .get("Edit")!
        .validate({ path: "a.txt", oldString: "gamma", newString: "delta" }),
    ).toContain("Read");
  });
  it("detects changes after Read and preserves the changed file", async () => {
    const tools = fileTools(new FileAccess(directory));
    await writeFile(join(directory, "a.txt"), "old");
    await tools.get("Read")!.execute({ path: "a.txt" }, signal());
    await writeFile(join(directory, "a.txt"), "external change");
    const output = await tools
      .get("Write")!
      .execute({ path: "a.txt", content: "overwrite" }, signal());
    expect(output).toMatchObject({ isError: true });
    expect(await readFile(join(directory, "a.txt"), "utf8")).toBe(
      "external change",
    );
  });
  it("creates a new nested file and rejects ambiguous Edit", async () => {
    const tools = fileTools(new FileAccess(directory));
    expect(
      (
        await tools
          .get("Write")!
          .execute({ path: "nested/a.txt", content: "one one" }, signal())
      ).isError,
    ).not.toBe(true);
    await tools.get("Read")!.execute({ path: "nested/a.txt" }, signal());
    expect(
      (
        await tools
          .get("Edit")!
          .execute(
            { path: "nested/a.txt", oldString: "one", newString: "two" },
            signal(),
          )
      ).isError,
    ).toBe(true);
    expect(await readFile(join(directory, "nested/a.txt"), "utf8")).toBe(
      "one one",
    );
  });
  it("rejects credential files and malformed schemas", async () => {
    const tools = fileTools(new FileAccess(directory));
    expect(
      await tools.get("Read")!.validate({ path: "auth.json" }),
    ).toBeTruthy();
    expect(
      await tools.get("Read")!.validate({ path: "a.txt", extra: true }),
    ).toBeTruthy();
    expect(
      await tools
        .get("Edit")!
        .validate({ path: "a.txt", oldString: "", newString: "x" }),
    ).toBeTruthy();
  });
});
describe("PowerShell and ripgrep tools", () => {
  it("finds files/content and treats no matches as success", async () => {
    await writeFile(join(directory, "a.txt"), "needle\n");
    const tools = shellSearchTools(directory);
    expect(
      (await tools.get("Glob")!.execute({ pattern: "*.txt" }, signal()))
        .content,
    ).toContain("a.txt");
    expect(
      (await tools.get("Grep")!.execute({ pattern: "needle" }, signal()))
        .content,
    ).toContain("needle");
    expect(
      (await tools.get("Grep")!.execute({ pattern: "absent" }, signal()))
        .isError,
    ).toBe(false);
    expect(
      (await tools.get("Grep")!.execute({ pattern: "[" }, signal())).isError,
    ).toBe(true);
  });
  it("executes PowerShell and bounds timeout values", async () => {
    const tool = shellSearchTools(directory).get("Bash")!;
    const output = await tool.execute(
      { command: "Write-Output 'hello'" },
      signal(),
    );
    expect(output.isError).toBe(false);
    const parsed = JSON.parse(output.content) as {
      output: string;
      completedAt: string;
    };
    expect(parsed.output.trim()).toBe("hello");
    expect(new Date(parsed.completedAt).toISOString()).toBe(parsed.completedAt);
    expect(await tool.validate({ command: "x", timeoutSec: 601 })).toBeTruthy();
  });
  it("terminates a timed-out process", async () => {
    const output = await shellSearchTools(directory)
      .get("Bash")!
      .execute({ command: "Start-Sleep -Seconds 10", timeoutSec: 1 }, signal());
    expect(output.isError).toBe(true);
    expect(output.content).toContain("timed out");
  }, 10000);
});
it("keeps both ends of long output and masks known credentials", () => {
  const text = "start" + "x".repeat(40000) + "end";
  expect(trimOutput(text).length).toBeLessThanOrEqual(30000);
  expect(trimOutput(text)).toMatch(/^start[\s\S]*end$/);
  expect(redact("prefix token-value-123 suffix", ["token-value-123"])).toBe(
    "prefix token-… suffix",
  );
});
