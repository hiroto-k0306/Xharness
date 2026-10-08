import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SDK_NAME = "@anthropic-ai/claude-agent-sdk";
export const SDK_BASELINE = "0.3.290";
export const nativePackage = () =>
  `${SDK_NAME}-${process.platform}-${process.arch}`;
export interface SdkPackage {
  name: string;
  version: string;
  main?: string;
  type?: string;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  dist?: { tarball: string; integrity: string };
}
export function compatibleSdk(candidate: SdkPackage, baseline: SdkPackage) {
  const stable = /^0\.3\.(\d+)$/;
  const version = stable.exec(candidate.version);
  const equal = (a: unknown, b: unknown) =>
    JSON.stringify(Object.entries((a ?? {}) as object).sort()) ===
    JSON.stringify(Object.entries((b ?? {}) as object).sort());
  const optional = (pkg: SdkPackage) =>
    Object.fromEntries(
      Object.entries(pkg.optionalDependencies ?? {}).map(([name, version]) => [
        name,
        /^@anthropic-ai\/claude-agent-sdk-(linux-(x64|arm64)(-musl)?|darwin-(x64|arm64)|win32-(x64|arm64))$/.test(
          name,
        ) && version === pkg.version
          ? "$paired-version"
          : version,
      ]),
    );
  return (
    !!version &&
    Number(version[1]) >= 290 &&
    candidate.name === SDK_NAME &&
    candidate.main === baseline.main &&
    candidate.type === baseline.type &&
    equal(candidate.dependencies, baseline.dependencies) &&
    equal(candidate.peerDependencies, baseline.peerDependencies) &&
    equal(candidate.peerDependenciesMeta, baseline.peerDependenciesMeta) &&
    equal(candidate.engines, baseline.engines) &&
    equal(optional(candidate), optional(baseline)) &&
    candidate.optionalDependencies?.[nativePackage()] === candidate.version
  );
}
/** Only the public official registry; never inherit auth headers or follow redirects. */
export async function registryBytes(
  url: string,
  limit: number,
  fetcher = fetch,
) {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://registry.npmjs.org" ||
    parsed.username ||
    parsed.password
  )
    throw new Error("sdk-registry-origin-rejected");
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok || !response.body)
    throw new Error("sdk-registry-unavailable");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw new Error("sdk-download-too-large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export async function registryPackage(
  name: string,
  version: string,
  fetcher = fetch,
) {
  const raw = await registryBytes(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    2 * 1024 * 1024,
    fetcher,
  );
  const value = JSON.parse(raw.toString("utf8")) as SdkPackage;
  if (
    value.name !== name ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    (version !== "latest" && value.version !== version)
  )
    throw new Error("sdk-registry-metadata-invalid");
  return value;
}
/** Small strict npm tar reader: directories/regular files only, no links or scripts. */
export async function unpackSdk(
  bytes: Buffer,
  integrity: string,
  destination: string,
) {
  if (
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity) ||
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !==
      integrity
  )
    throw new Error("sdk-integrity-mismatch");
  const tar = gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 });
  const seen = new Set<string>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((x) => x === 0)) return;
    const field = (start: number, end: number) =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const octal = (start: number, end: number) => {
      const value = field(start, end).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error("sdk-archive-invalid");
      return parseInt(value, 8);
    };
    const checksum = [...header].reduce(
      (n, v, i) => n + (i >= 148 && i < 156 ? 32 : v),
      0,
    );
    if (checksum !== octal(148, 156)) throw new Error("sdk-archive-checksum");
    const prefix = field(345, 500);
    const name = `${prefix ? `${prefix}/` : ""}${field(0, 100)}`;
    const type = field(156, 157);
    const size = octal(124, 136);
    if (
      !name.startsWith("package/") ||
      /[\\:\x00-\x1f]/.test(name) ||
      name
        .split("/")
        .some(
          (p) =>
            p.toLowerCase() === "node_modules" ||
            p === ".." ||
            p === "." ||
            /[. ]$/.test(p) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
        ) ||
      !["", "0", "5"].includes(type) ||
      offset + 512 + size > tar.length
    )
      throw new Error("sdk-archive-entry-rejected");
    const local = name.slice(8).replace(/\/$/, "");
    if (local) {
      if (seen.has(local.toLowerCase()))
        throw new Error("sdk-archive-duplicate");
      seen.add(local.toLowerCase());
      const target = join(destination, local);
      if (type === "5") await mkdir(target, { recursive: true });
      else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(
          target,
          tar.subarray(offset + 512, offset + 512 + size),
          { flag: "wx", mode: 0o700 },
        );
      }
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("sdk-archive-truncated");
}
export async function downloadPackage(
  pkg: SdkPackage,
  destination: string,
  fetcher = fetch,
) {
  if (!pkg.dist) throw new Error("sdk-package-dist-missing");
  await unpackSdk(
    await registryBytes(pkg.dist.tarball, 256 * 1024 * 1024, fetcher),
    pkg.dist.integrity,
    destination,
  );
}
