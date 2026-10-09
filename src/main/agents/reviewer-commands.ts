// reviewer の Bash(テスト実行用、旧設計 Old/DESIGN-9a275bc.md §10.1)で許すコマンドと、reviewer に伝える案内。
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** 許すコマンドの形(画面とエラーで同じ一覧を見せる) */
export const REVIEWER_COMMANDS = [
  "npm test",
  "npm run test|lint|typecheck|build",
  "pnpm test",
  "pnpm run test|lint|typecheck|build",
  ".\\scripts\\pnpm.ps1 [run] test|lint|typecheck|build (no extra arguments)",
  "./scripts/pnpm.ps1 [run] test|lint|typecheck|build (no extra arguments)",
  "yarn test",
  "npx vitest run",
  "vitest run",
  "node --test",
  "pytest",
];

const ALLOWED =
  /^(?:(?:pnpm|npm) (?:test|run (?:test|lint|typecheck|build))|yarn test|(?:npx )?vitest(?: run)?|node --test|pytest)(?:\s|$)/;

// Only the repository's fixed wrapper path and these four scripts. Do not
// generalize this to arbitrary .ps1 paths, shell launchers, or pnpm arguments.
const LOCAL_WRAPPER =
  /^(?:\.\\scripts\\pnpm\.ps1|\.\/scripts\/pnpm\.ps1)[ \t]+(?:run[ \t]+)?(?:test|lint|typecheck|build)$/;

/** reviewer の Bash として許すか。連結・リダイレクト・展開・部分式は許さない */
export function reviewerCommandAllowed(command: string): boolean {
  if (/[;|&<>\r\n$`(){}]/.test(command)) return false;
  const trimmed = command.trim();
  return ALLOWED.test(trimmed) || LOCAL_WRAPPER.test(trimmed);
}

export function reviewerCommandError(): string {
  return `Reviewer Bash runs only one test command at a time, already in the workspace (no cd, no chaining). Allowed: ${REVIEWER_COMMANDS.join(", ")}`;
}

/** そのプロジェクトで使うべきテストコマンドの案内(package.json の test スクリプトがあれば) */
export async function reviewerTestHint(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  let scripts: Record<string, unknown> = {};
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    scripts = (pkg?.scripts ?? {}) as Record<string, unknown>;
  } catch {
    /* package.json が無い・読めない */
  }
  const exists = (file: string) =>
    access(join(cwd, file)).then(
      () => true,
      () => false,
    );
  const runner = (await exists("pnpm-lock.yaml"))
    ? "pnpm"
    : (await exists("yarn.lock"))
      ? "yarn"
      : "npm";
  const isFile = (file: string) =>
    stat(join(cwd, file)).then(
      (info) => info.isFile(),
      () => false,
    );
  const localPnpm =
    platform === "win32" &&
    (await isFile(".tools/node_modules/.bin/pnpm.cmd")) &&
    (await isFile("scripts/pnpm.ps1"));
  const testCommand = localPnpm
    ? ".\\scripts\\pnpm.ps1 test"
    : `${runner} test`;
  const project =
    typeof scripts.test === "string"
      ? ` This project defines a test script: run \`${testCommand}\`.`
      : "";
  return `Bash may run only one test command at a time, already in the workspace; do not use cd or chain commands. Allowed: ${REVIEWER_COMMANDS.join(", ")}.${project}`;
}
