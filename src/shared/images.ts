export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const IMAGE_ERROR =
  "画像はPNG・JPEG・GIF・WebP、1枚5 MB以下、長辺8000px以下で指定してください。";
export interface ImageAttachment {
  mediaType: string;
  data: string;
}
export function imageInfo(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number, n: number) =>
    String.fromCharCode(...bytes.slice(at, at + n));
  let mediaType = "",
    width = 0,
    height = 0;
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error(IMAGE_ERROR);
  try {
    if (
      text(0, 8) === "\x89PNG\r\n\x1a\n" &&
      text(12, 4) === "IHDR" &&
      view.getUint32(8) === 13
    ) {
      mediaType = "image/png";
      width = view.getUint32(16);
      height = view.getUint32(20);
    } else if (["GIF87a", "GIF89a"].includes(text(0, 6))) {
      mediaType = "image/gif";
      width = view.getUint16(6, true);
      height = view.getUint16(8, true);
    } else if (bytes[0] === 255 && bytes[1] === 216) {
      for (let at = 2; at + 3 < bytes.length;) {
        if (bytes[at++] !== 255) break;
        while (bytes[at] === 255) at++;
        const marker = bytes[at++]!;
        if (marker === 217 || marker === 218) break;
        const length = view.getUint16(at);
        if (length < 2 || at + length > bytes.length) break;
        if (
          [
            192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
          ].includes(marker) &&
          length >= 8
        ) {
          mediaType = "image/jpeg";
          height = view.getUint16(at + 3);
          width = view.getUint16(at + 5);
          break;
        }
        at += length;
      }
    } else if (text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
      const chunk = text(12, 4);
      if (chunk === "VP8X") {
        width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
        height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
      } else if (chunk === "VP8L" && bytes[20] === 47) {
        const bits = view.getUint32(21, true);
        width = 1 + (bits & 0x3fff);
        height = 1 + ((bits >>> 14) & 0x3fff);
      } else if (chunk === "VP8 " && text(23, 3) === "\x9d\x01\x2a") {
        width = view.getUint16(26, true) & 0x3fff;
        height = view.getUint16(28, true) & 0x3fff;
      }
      if (width && height) mediaType = "image/webp";
    }
  } catch {
    throw new Error(IMAGE_ERROR);
  }
  if (!mediaType || !width || !height || width > 8000 || height > 8000)
    throw new Error(IMAGE_ERROR);
  return { mediaType, width, height, bytes: bytes.length };
}
export function attachmentInfo(value: ImageAttachment) {
  if (
    typeof value?.data !== "string" ||
    value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    value.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
  )
    throw new Error(IMAGE_ERROR);
  const info = imageInfo(
    Uint8Array.from(atob(value.data), (c) => c.charCodeAt(0)),
  );
  if (info.mediaType !== value.mediaType) throw new Error(IMAGE_ERROR);
  return info;
}
/** JSON replacer used only for receipts/traces/reports, never the provider input/history. */
export function imageMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  const source = v.source as Record<string, unknown> | undefined;
  const url =
    typeof v.image_url === "string"
      ? /^data:(image\/[\w+.-]+);base64,(.*)$/s.exec(v.image_url)
      : null;
  const data =
    v.type === "image"
      ? (v.data ?? (source?.type === "base64" ? source.data : undefined))
      : url?.[2];
  if (typeof data !== "string") return value;
  const mediaType = String(
    v.mediaType ?? source?.media_type ?? url?.[1] ?? "image",
  );
  return {
    type: v.type,
    mediaType,
    bytes:
      Math.floor((data.length * 3) / 4) -
      (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0),
    omitted: "画像本体は記録しません",
  };
}
