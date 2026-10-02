import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  reviewerCommandAllowed,
  reviewerCommandError,
  reviewerTestHint,
} from "./reviewer-commands.js";

describe("reviewer Bash (test commands only)", () => {
  it.each([
    "npm test",
    "pnpm test",
    "pnpm run lint",
    "yarn test",
    "npx vitest run",
    "node --test",
    "pytest -q",
  ])("allows %s", (command) =>
    expect(reviewerCommandAllowed(command)).toBe(true),
  );
  it.each([
    // 安定化の通し確認で実際に拒否された2件
    "Set-Location D:\\work\\sample; node sum.test.js; git diff --name-only",
    "node sum.test.js",
    "npm test; Remove-Item x",
    "npm test (calc)",
    "npm install",
    "node -e process.exit(0)",
  ])("rejects %s", (command) =>
    expect(reviewerCommandAllowed(command)).toBe(false),
  );
  it("explains what is allowed when it rejects", () => {
    expect(reviewerCommandError()).toContain("npm test");
    expect(reviewerCommandError()).toContain("no cd");
  });
  it("tells the reviewer which test command this project uses", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "xh-reviewer-"));
    expect(await reviewerTestHint(cwd)).not.toContain("defines a test script");
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify({ scripts: { test: "node sum.test.js" } }),
    );
    expect(await reviewerTestHint(cwd)).toContain("`npm test`");
    await writeFile(join(cwd, "pnpm-lock.yaml"), "");
    expect(await reviewerTestHint(cwd)).toContain("`pnpm test`");
  });
});
