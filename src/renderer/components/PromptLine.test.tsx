import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import image from "../../../test/fixtures/images/pixel.js";
import { PromptLine } from "./PromptLine.js";
function file() {
  return new File(
    [Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0))],
    "pixel.png",
    { type: "image/png" },
  );
}
const props = {
  cwdLabel: "test",
  running: false,
  blocked: false,
  modelLabel: "model",
  modelColor: "red",
};
it("clears the attachment draft when switching sessions", async () => {
  const view = render(
    <PromptLine {...props} sessionId="first" onSubmit={() => {}} />,
  );
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { files: [file()] },
  });
  await screen.findByAltText("添付画像 1");
  view.rerender(
    <PromptLine {...props} sessionId="second" onSubmit={() => {}} />,
  );
  expect(screen.queryByAltText("添付画像 1")).toBeNull();
});
it("does not show an unverified notice when image support is unknown", async () => {
  render(<PromptLine {...props} onSubmit={() => {}} />);
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { files: [file()] },
  });
  await screen.findByAltText("添付画像 1");
  expect(screen.queryByRole("status")).toBeNull();
  expect(screen.queryByText(/未確認/)).toBeNull();
});
it("refuses the sixth attachment and keeps the first five", async () => {
  render(<PromptLine {...props} onSubmit={() => {}} />);
  const textbox = screen.getByRole("textbox");
  fireEvent.paste(textbox, {
    clipboardData: { files: Array.from({ length: 5 }, () => file()) },
  });
  await screen.findByAltText("添付画像 5");
  fireEvent.paste(textbox, { clipboardData: { files: [file()] } });
  expect(
    await screen.findByText("画像の添付は1メッセージ5枚までです。"),
  ).toBeInTheDocument();
  expect(screen.queryByAltText("添付画像 6")).toBeNull();
});
it("pastes an image, warns for a text-only model, submits unchanged bytes and restores rejected attachments", async () => {
  const onSubmit = vi.fn().mockResolvedValue(false);
  render(<PromptLine {...props} imageInput={false} onSubmit={onSubmit} />);
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { files: [file()] },
  });
  await screen.findByAltText("添付画像 1");
  expect(screen.getByRole("status")).toHaveTextContent("対応していません");
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("", [image]));
  await screen.findByAltText("添付画像 1");
  fireEvent.click(screen.getByRole("button", { name: "添付画像 1を削除" }));
  expect(screen.queryByAltText("添付画像 1")).toBeNull();
});
it("drops images, preserves ordinary pasted text, and refuses corrupted image data", async () => {
  const onSubmit = vi.fn();
  render(<PromptLine {...props} imageInput onSubmit={onSubmit} />);
  fireEvent.drop(screen.getByRole("textbox").parentElement!, {
    dataTransfer: { files: [file()] },
  });
  await screen.findByAltText("添付画像 1");
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: { files: [] },
  });
  fireEvent.drop(screen.getByRole("textbox").parentElement!, {
    dataTransfer: {
      files: [new File(["invalid"], "bad.png", { type: "image/png" })],
    },
  });
  await screen.findByRole("alert");
  expect(screen.getAllByRole("img")).toHaveLength(1);
});
