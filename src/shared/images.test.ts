import { expect, it } from "vitest";
import image from "../../test/fixtures/images/pixel.js";
import {
  imageInfo,
  attachmentInfo,
  imageMetadata,
  MAX_IMAGE_BYTES,
} from "./images.js";
import { parseCommand } from "./ipc.js";
it("accepts the PNG fixture and strips unrelated attachment IPC fields", () => {
  expect(attachmentInfo(image)).toMatchObject({
    width: 1,
    height: 1,
    mediaType: "image/png",
  });
  expect(
    parseCommand({
      type: "send",
      sessionId: "test",
      text: "",
      images: [{ ...image, path: "ignored" }],
    }),
  ).toEqual({ type: "send", sessionId: "test", text: "", images: [image] });
});
it("rejects mismatched MIME, invalid base64, oversized and overdimension images before dispatch", () => {
  for (const invalid of [
    { ...image, mediaType: "image/jpeg" },
    { ...image, data: "not base64" },
    { ...image, data: "A".repeat(8_000_000) },
  ]) {
    expect(() => attachmentInfo(invalid)).toThrow("画像");
    expect(
      parseCommand({
        type: "send",
        sessionId: "test",
        text: "a",
        images: [invalid],
      }),
    ).toBeUndefined();
  }
  const bytes = Buffer.from(image.data, "base64");
  bytes.writeUInt32BE(8001, 16);
  expect(() => imageInfo(bytes)).toThrow("8000");
  expect(() => imageInfo(Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow("5 MB");
  expect(() => imageInfo(bytes.subarray(0, 18))).toThrow("画像");
});
it("reads JPEG/GIF/WebP header dimensions without external libraries", () => {
  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    "base64",
  );
  expect(imageInfo(gif)).toMatchObject({
    mediaType: "image/gif",
    width: 1,
    height: 1,
  });
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 8, 8, 0, 2, 0, 3, 1]);
  expect(imageInfo(jpeg)).toMatchObject({
    mediaType: "image/jpeg",
    width: 3,
    height: 2,
  });
  for (const chunk of ["VP8X", "VP8L", "VP8 "]) {
    const webp = Buffer.alloc(30);
    webp.write("RIFF");
    webp.write("WEBP", 8);
    webp.write(chunk, 12);
    if (chunk === "VP8X") {
      webp[24] = 2;
      webp[27] = 1;
    }
    if (chunk === "VP8L") {
      webp[20] = 47;
      webp.writeUInt32LE(2 | (1 << 14), 21);
    }
    if (chunk === "VP8 ") {
      webp.set([157, 1, 42], 23);
      webp.writeUInt16LE(3, 26);
      webp.writeUInt16LE(2, 28);
    }
    expect(imageInfo(webp)).toMatchObject({
      mediaType: "image/webp",
      width: 3,
      height: 2,
    });
  }
});
it("omits both native and internal image payloads, retaining MIME and byte size", () => {
  for (const value of [
    { type: "image", ...image },
    {
      type: "image",
      source: { type: "base64", media_type: image.mediaType, data: image.data },
    },
    {
      type: "input_image",
      image_url: `data:${image.mediaType};base64,${image.data}`,
    },
  ]) {
    const record = imageMetadata(value);
    expect(JSON.stringify(record)).not.toContain(image.data);
    expect(record).toMatchObject({
      mediaType: image.mediaType,
      bytes: Buffer.from(image.data, "base64").length,
    });
  }
});
