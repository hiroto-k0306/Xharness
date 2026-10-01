// brand/icon.svg から resources/icon.ico を生成する(DESIGN.md §16.10)。
//   pnpm icon
// 16 / 24 / 32 / 48 / 64 / 128 / 256px の PNG を sharp で書き出し、png-to-ico で1つにまとめる。
// 16・24px は線が細くなりすぎないよう、影(<g id="shadow">)を省いた版を使う。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;
/** この大きさ以下は影なし版 */
export const NO_SHADOW_MAX = 24;

/** 影のグループを取り除いた SVG(16・24px 用) */
export function withoutShadow(svg: string): string {
  const out = svg.replace(/<g id="shadow">[\s\S]*?<\/g>/, "");
  if (out === svg) throw new Error('icon.svg に <g id="shadow"> がありません');
  return out;
}

/** 目的の大きさで直接ラスタライズする(縮小で細い線を落とさない) */
export function rasterize(svg: string, size: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: (72 * size) / 512 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function renderPngs(svg: string): Promise<Map<number, Buffer>> {
  const flat = withoutShadow(svg);
  const pngs = new Map<number, Buffer>();
  for (const size of ICON_SIZES)
    pngs.set(size, await rasterize(size <= NO_SHADOW_MAX ? flat : svg, size));
  return pngs;
}

export async function buildIco(svg: string): Promise<Buffer> {
  const pngs = await renderPngs(svg);
  return pngToIco([...pngs.values()]);
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const svg = await readFile(resolve(root, "brand/icon.svg"), "utf8");
  const out = resolve(root, "resources/icon.ico");
  await mkdir(dirname(out), { recursive: true });
  const ico = await buildIco(svg);
  await writeFile(out, ico);
  process.stdout.write(
    `wrote ${out} (${ico.length} bytes, ${ICON_SIZES.join("/")}px)\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error: unknown) => {
    process.stderr.write(
      `icon generation failed: ${error instanceof Error ? error.message : "unknown"}\n`,
    );
    process.exitCode = 1;
  });
