import { expect, it } from "vitest";
import { compareOfflineConnections } from "./offline.js";

it("compares A/B by independently observed acceptance on fixed and heldout tasks", async () => {
  const report = await compareOfflineConnections();
  expect(report.environment).toBe("offline-injected-mock");
  expect(report.rows).toHaveLength(4);
  expect(report.rows.every((row) => row.passed)).toBe(true);
  expect(report.rows.map((row) => row.toolExecutions)).toEqual([1, 1, 0, 0]);
  expect(
    report.rows.every((row) => row.outcome.measurement?.input === 12),
  ).toBe(true);
});
