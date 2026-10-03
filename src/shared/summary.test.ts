import { expect, it } from "vitest";
import { detailInput, summarizeInput } from "./summary.js";

it("uses the command string as is for command inputs", () => {
  const command = 'git log --format="%h"\nls -la';
  expect(detailInput("Bash", { command, timeout: 5 })).toBe(command);
});

it("pretty-prints other inputs as JSON", () => {
  expect(detailInput("Read", { path: "a.txt" })).toBe(
    JSON.stringify({ path: "a.txt" }, null, 2),
  );
  expect(detailInput("Bash", { command: 1 })).toBe(
    JSON.stringify({ command: 1 }, null, 2),
  );
});

it("returns an empty string when the input cannot be serialized", () => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  expect(detailInput("X", loop)).toBe("");
  expect(detailInput("X", undefined)).toBe("");
});

it("truncates to max characters and marks the omission", () => {
  expect(detailInput("Bash", { command: "a".repeat(10) }, undefined, 4)).toBe(
    "aaaa\n…(省略)",
  );
  const long = detailInput("Bash", { command: "b".repeat(5000) });
  expect(long).toBe("b".repeat(4000) + "\n…(省略)");
  expect(detailInput("Bash", { command: "b".repeat(4000) })).toBe(
    "b".repeat(4000),
  );
});

it("passes the text through clean before truncating", () => {
  const clean = (s: string) => s.replaceAll("SECRET", "***");
  expect(detailInput("Bash", { command: "echo SECRET" }, clean)).toBe(
    "echo ***",
  );
  expect(detailInput("Write", { text: "SECRET" }, clean)).not.toContain(
    "SECRET",
  );
});

it("leaves summarizeInput unchanged", () => {
  expect(summarizeInput("Read", { path: "a" })).toBe('Read {"path":"a"}');
});
