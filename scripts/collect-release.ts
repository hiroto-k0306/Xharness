// 配布に必要なファイルだけを、開発環境(リポジトリ)の外のフォルダへ集める。
//   pnpm release            # exe を作ってから集める(手元の Windows で実行)
//   pnpm release:collect    # 作成済みの exe を集めるだけ
//   pnpm release:collect -- --out D:\XHarness-release --force
// 集めるもの: インストーラ版・ポータブル版の exe、利用者向けの README、SHA256SUMS.txt。
// 既定の保存先は、リポジトリと同じ階層の XHarness-release\XHarness-<版>\。
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export interface CollectOptions {
  /** リポジトリの場所(試験で差し替える) */
  root?: string;
  /** 集める先の親フォルダ。この下に XHarness-<版> を作る */
  out?: string;
  /** 同じ版のフォルダが既にあっても上書きする */
  force?: boolean;
}

/** 集めるファイル(electron-builder.yml の artifactName と合わせる) */
export function releaseFiles(version: string) {
  return {
    installer: `XHarness-Setup-${version}.exe`,
    portable: `XHarness-${version}-portable.exe`,
  };
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function collectRelease(options: CollectOptions = {}) {
  const root = options.root ?? ROOT;
  const pkg = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  const files = releaseFiles(pkg.version);
  const parent = resolve(options.out ?? join(root, "..", "XHarness-release"));
  const target = join(parent, `XHarness-${pkg.version}`);
  // 開発環境とは分けて保管する。リポジトリの中には置かない(exe を誤ってコミットしないため)
  const rel = relative(root, target);
  if (!rel.startsWith("..") && !isAbsolute(rel))
    throw new Error(
      `保存先がリポジトリの中です: ${target}。リポジトリの外を --out で指定してください`,
    );
  const sources = [
    join(root, "dist", files.installer),
    join(root, "dist", files.portable),
  ];
  for (const source of sources)
    try {
      await access(source);
    } catch {
      throw new Error(
        `${basename(source)} がありません。先に pnpm package を実行してください(版: ${pkg.version})`,
      );
    }
  let existing: string[] = [];
  try {
    existing = await readdir(target);
  } catch {
    /* まだ無い */
  }
  if (existing.length && !options.force)
    throw new Error(
      `${target} は既にあります。保管済みの版を守るため上書きしません(上書きするなら --force)`,
    );
  await mkdir(target, { recursive: true });
  const copied: string[] = [];
  for (const source of [...sources, join(root, "release", "README.md")]) {
    await copyFile(source, join(target, basename(source)));
    copied.push(basename(source));
  }
  const sums = await Promise.all(
    copied.map(async (name) => `${await sha256(join(target, name))}  ${name}`),
  );
  await writeFile(
    join(target, "SHA256SUMS.txt"),
    sums.join("\n") + "\n",
    "utf8",
  );
  return { target, files: [...copied, "SHA256SUMS.txt"] };
}

function parseArgs(argv: string[]): CollectOptions {
  const options: CollectOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force") options.force = true;
    else if (arg === "--out") options.out = argv[++i];
    else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg !== "--") throw new Error(`不明な引数: ${arg}`);
  }
  return options;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  collectRelease(parseArgs(process.argv.slice(2))).then(
    (result) => {
      process.stdout.write(
        `配布用ファイルを集めました: ${result.target}\n${result.files
          .map((f) => `  ${f}`)
          .join("\n")}\n`,
      );
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}
