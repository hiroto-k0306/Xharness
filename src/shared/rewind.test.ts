import { expect, it } from "vitest";
import { rewindTurns } from "./rewind.js";
import { parseCommand } from "./ipc.js";
it("accepts local commands with positive, safe turn counts", () => {
  expect(rewindTurns("/undo")).toBe(1);
  expect(rewindTurns("/rewind 2")).toBe(2);
  for (const value of [
    "/undo 2",
    "/rewind 0",
    "/rewind -1",
    "/rewind 1.5",
    "/rewind 9007199254740992",
  ])
    expect(rewindTurns(value)).toBeUndefined();
});
it("validates confirmation payloads and supports cancellation", () => {
  const base = { type: "rewind_response", sessionId: "s", requestId: "r" };
  expect(parseCommand({ ...base, choice: null })).toEqual({
    ...base,
    choice: null,
  });
  expect(
    parseCommand({
      ...base,
      choice: { scope: "both", includeConflicts: ["a", "a"] },
    }),
  ).toMatchObject({ choice: { scope: "both", includeConflicts: ["a"] } });
  for (const choice of [
    { scope: "all", includeConflicts: [] },
    { scope: "code", includeConflicts: [3] },
    {},
  ])
    expect(parseCommand({ ...base, choice })).toBeUndefined();
  expect(
    parseCommand({ type: "delete_session", sessionId: "s", confirmed: true }),
  ).toBeDefined();
  expect(
    parseCommand({ type: "delete_session", sessionId: "s" }),
  ).toBeUndefined();
});
