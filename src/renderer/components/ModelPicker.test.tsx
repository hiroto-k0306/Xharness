import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ModelPicker } from "./ModelPicker.js";

const models = [
  {
    id: "gpt-current-sol",
    alias: "sol",
    provider: "codex" as const,
    label: "Sol",
    efforts: ["low", "high"] as const,
    defaultEffort: "low" as const,
  },
].map((model) => ({ ...model, efforts: [...model.efforts] }));

it("sends an alias policy and separate effort for session and default selections", () => {
  const apply = vi.fn(async () => {}),
    defaults = vi.fn(async () => {});
  render(
    <ModelPicker
      models={models}
      model="codex:sol"
      effort="high"
      aliasPolicies
      onApply={apply}
      onDefault={defaults}
      onClose={() => {}}
    />,
  );
  expect(
    screen.getByRole("option", { name: "codex:sol → gpt-current-sol" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText("apply · このセッション"));
  fireEvent.click(screen.getByText("既定にする"));
  expect(apply).toHaveBeenCalledWith("codex:sol", "high");
  expect(defaults).toHaveBeenCalledWith("codex:sol", "high");
});

it("requires an explicit choice for a historical ID with no current alias", () => {
  const apply = vi.fn(async () => {});
  render(
    <ModelPicker
      models={models}
      model="retired-full-id"
      effort="high"
      aliasPolicies
      onApply={apply}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("apply · このセッション")).toBeDisabled();
  expect(
    screen.getByRole("option", { name: /retired-full-id/ }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "モデル" }), {
    target: { value: "codex:sol" },
  });
  fireEvent.click(screen.getByText("apply · このセッション"));
  expect(apply).toHaveBeenCalledWith("codex:sol", "low");
});

it("shows an updated resolved ID while keeping the alias policy selection", () => {
  const props = {
    model: "codex:sol",
    effort: "high" as const,
    aliasPolicies: true,
    onApply: vi.fn(async () => {}),
    onClose: () => {},
  };
  const view = render(<ModelPicker {...props} models={models} />);
  view.rerender(
    <ModelPicker {...props} models={[{ ...models[0]!, id: "gpt-next-sol" }]} />,
  );
  expect(screen.getByRole("combobox", { name: "モデル" })).toHaveValue(
    "codex:sol",
  );
  expect(
    screen.getByRole("option", { name: "codex:sol → gpt-next-sol" }),
  ).toBeInTheDocument();
});

it("keeps explicit fake selection without an alias in the development fixture", () => {
  const apply = vi.fn(async () => {});
  render(
    <ModelPicker
      models={[{ id: "fake", label: "fake", provider: "claude", efforts: [] }]}
      model="fake"
      effort="high"
      onApply={apply}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByText("apply · このセッション"));
  expect(apply).toHaveBeenCalledWith("fake", undefined);
});
