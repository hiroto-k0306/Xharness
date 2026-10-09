import { expect, it } from "vitest";
import { approvedWriteScope, withinWriteScope } from "./write-scope.js";
it("restricts DAG direct writes to exact approved files", () => {
  const scope = approvedWriteScope({
    cwd: "/workspace/fixture",
    nativeWork: true,
    writeScope: ["src/a.ts"],
  });
  expect(withinWriteScope(scope, "/workspace/fixture", "src/a.ts")).toBe(true);
  expect(withinWriteScope(scope, "/workspace/fixture", "src/b.ts")).toBe(false);
  expect(withinWriteScope(scope, "/workspace/fixture", "../a.ts")).toBe(false);
});
it.each([
  { writeScope: [] },
  { writeScope: ["../outside.ts"] },
  { writeScope: ["auth.json"] },
  { writeScope: ["/absolute.ts"] },
  { writeScope: ["a.ts", "A.ts"] },
])("rejects unsafe or ambiguous scope %j", ({ writeScope }) => {
  expect(() =>
    approvedWriteScope({
      cwd: "/workspace/fixture",
      nativeWork: true,
      writeScope,
    }),
  ).toThrow("invalid-write-scope");
});
it("preserves unscoped native work and rejects scope on synthetic work", () => {
  expect(
    approvedWriteScope({ cwd: "/workspace/fixture", nativeWork: true }),
  ).toBeUndefined();
  expect(() =>
    approvedWriteScope({ cwd: "/workspace/fixture", writeScope: ["a.ts"] }),
  ).toThrow();
});
