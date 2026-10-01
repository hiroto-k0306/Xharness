import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ICON_SIZES,
  buildIco,
  rasterize,
  renderPngs,
  withoutShadow,
} from "./make-icon.js";

const svg = await readFile("brand/icon.svg", "utf8");

describe("icon generation", () => {
  it("removes only the shadow group for small sizes", () => {
    const flat = withoutShadow(svg);
    expect(svg).toContain('id="shadow"');
    expect(flat).not.toContain('id="shadow"');
    expect(flat).toContain('id="x"');
    expect(() => withoutShadow("<svg/>")).toThrow();
  });
  it("renders every size as a square PNG", async () => {
    const pngs = await renderPngs(svg);
    expect([...pngs.keys()]).toEqual([...ICON_SIZES]);
    for (const [size, png] of pngs) {
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect(png.readUInt32BE(16)).toBe(size); // IHDR width
      expect(png.readUInt32BE(20)).toBe(size); // IHDR height
    }
  });
  it("16 and 24px use the no-shadow SVG; 32px and above use the full SVG", async () => {
    const pngs = await renderPngs(svg);
    const { default: sharp } = await import("sharp");
    const pixels = (png: Buffer) => sharp(png).ensureAlpha().raw().toBuffer();
    const flat = withoutShadow(svg);
    for (const size of [16, 24])
      expect(
        (await pixels(pngs.get(size)!)).equals(
          await pixels(await rasterize(flat, size)),
        ),
      ).toBe(true);
    for (const size of [32, 256])
      expect(
        (await pixels(pngs.get(size)!)).equals(
          await pixels(await rasterize(svg, size)),
        ),
      ).toBe(true);
    // 大きいサイズでは影が実際に描かれている(影なし版と画素が違う)
    expect(
      (await pixels(pngs.get(256)!)).equals(
        await pixels(await rasterize(flat, 256)),
      ),
    ).toBe(false);
  });
  it("packs all sizes into one .ico", async () => {
    const ico = await buildIco(svg);
    expect(ico.readUInt16LE(0)).toBe(0); // reserved
    expect(ico.readUInt16LE(2)).toBe(1); // type: icon
    expect(ico.readUInt16LE(4)).toBe(ICON_SIZES.length);
    const widths = Array.from(
      { length: ICON_SIZES.length },
      (_, i) => ico[6 + i * 16] || 256,
    );
    expect(widths).toEqual([...ICON_SIZES]);
  });
});
