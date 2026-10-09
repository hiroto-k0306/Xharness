import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { loadCatalog, resolveModelPolicy } from "./catalog.js";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, readFileSync: vi.fn(original.readFileSync) };
});

const original = await vi.importActual<typeof import("node:fs")>("node:fs");
const read = vi.mocked(readFileSync);
afterEach(() => {
  read.mockReset();
  read.mockImplementation(original.readFileSync);
});
const yaml = (id: string) =>
  `version: 1\nmodels:\n  - {provider: codex, id: ${id}, alias: sol, enabled: true, efforts: {high: high}, defaultEffort: high}\n`;

it("rereads changed catalog contents before the next resolution without changing prior results", () => {
  read
    .mockReturnValueOnce(yaml("first-id"))
    .mockReturnValueOnce(yaml("next-id"));
  const first = resolveModelPolicy("codex:sol", "high");
  const second = resolveModelPolicy("codex:sol", "high");
  expect(first.id).toBe("first-id");
  expect(second.id).toBe("next-id");
  expect(second.catalog.digest).not.toBe(first.catalog.digest);
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not reuse a previous valid catalog or try another layout after corruption", () => {
  read
    .mockReturnValueOnce(yaml("valid-id"))
    .mockReturnValueOnce("models: [unclosed");
  expect(loadCatalog().models[0]!.id).toBe("valid-id");
  expect(() => loadCatalog()).toThrow();
  expect(read).toHaveBeenCalledTimes(2);
});

it("tries the bundled layout only when the source layout does not exist", () => {
  read
    .mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    })
    .mockReturnValueOnce(yaml("bundled-id"));
  expect(loadCatalog().models[0]!.id).toBe("bundled-id");
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[0]![0]).not.toEqual(read.mock.calls[1]![0]);
});

it("stops on read errors and conflicting aliases rather than trying another layout", () => {
  read.mockImplementationOnce(() => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  expect(() => loadCatalog()).toThrow("denied");
  expect(read).toHaveBeenCalledTimes(1);
  read.mockClear();
  read.mockReturnValueOnce(
    yaml("first-id") +
      "  - {provider: codex, id: duplicate-id, alias: sol, enabled: true}\n",
  );
  expect(() => resolveModelPolicy("codex:sol", "high")).toThrow(/競合/);
  expect(read).toHaveBeenCalledTimes(1);
});
