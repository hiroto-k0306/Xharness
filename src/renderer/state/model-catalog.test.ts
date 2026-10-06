import { afterEach, expect, it } from "vitest";
import {
  setUiModelCatalog,
  uiProviderOf,
  uiSendsEffort,
} from "./model-catalog.js";
import { providerOf } from "./steps.js";

afterEach(() => setUiModelCatalog(undefined));

it("reads provider and effort display from the catalog the main process sent", () => {
  // A catalog entry decides, even when the name would suggest otherwise.
  setUiModelCatalog([
    { id: "claude-haiku-4-5-20251001", provider: "claude", efforts: [] },
    { id: "claude-sonnet-5-5", provider: "claude", efforts: ["high"] },
    { id: "gpt-renamed", provider: "claude", efforts: ["low"] },
    { id: "new-codex-model", provider: "codex", efforts: ["low"] },
  ]);
  expect(uiSendsEffort("claude-haiku-4-5-20251001")).toBe(false);
  expect(uiSendsEffort("claude-sonnet-5-5")).toBe(true);
  expect(providerOf("gpt-renamed")).toBe("claude");
  expect(providerOf("new-codex-model")).toBe("codex");
  // Changing only the catalog changes the display.
  setUiModelCatalog([
    { id: "claude-sonnet-5-5", provider: "claude", efforts: [] },
  ]);
  expect(uiSendsEffort("claude-sonnet-5-5")).toBe(false);
});
it("keeps the former rules for IDs outside the catalog", () => {
  setUiModelCatalog([]);
  expect(uiProviderOf("gpt-unknown")).toBe("codex");
  expect(uiProviderOf("something-else")).toBe("claude");
  expect(uiSendsEffort("unknown-model")).toBe(true);
  expect(uiSendsEffort("fake")).toBe(false);
});
