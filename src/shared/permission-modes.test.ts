import { expect, it } from "vitest";
import { resolvePermissionMode } from "./permission-modes.js";

it.each([
  ["通常", "default"],
  ["default", "default"],
  ["自動", "acceptEdits"],
  ["auto", "acceptEdits"],
  ["acceptEdits", "acceptEdits"],
  ["計画", "plan"],
  ["plan", "plan"],
  ["unknown", undefined],
  [undefined, undefined],
])(
  "normalizes permission mode %s without changing stored values",
  (value, mode) => {
    expect(resolvePermissionMode(value)).toBe(mode);
  },
);
