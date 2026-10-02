// reviewer の Bash(テスト実行用、DESIGN.md §10.1)で許すコマンドと、reviewer に伝える案内。
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 許すコマンドの形(画面とエラーで同じ一覧を見せる) */
export const REVIEWER_COMMANDS = [
  "npm test",
  "npm run test|lint|typecheck|build",
  "pnpm test",
  "pnpm run test|lint|typecheck|build",
  "yarn test",
  "npx vitest run",
  "vitest run",
  "node --test",
  "pytest",
];

const ALLOWED =
  /^(?:(?:pnpm|npm) (?:test|run (?:test|lint|typecheck|build))|yarn test|(?:npx )?vitest(?: run)?|node --test|pytest)(?:\s|$)/;

/** reviewer の Bash として許すか。連結・リダイレクト・展開・部分式は許さない */
export function reviewerCommandAllowed(command: string): boolean {
  return !/[;|&<>\r\n$`(){}]/.test(command) && ALLOWED.test(command.trim());
}

export function reviewerCommandError(): string {
  return `Reviewer Bash runs only one test command at a time, already in the workspace (no cd, no chaining). Allowed: ${REVIEWER_COMMANDS.join(", ")}`;
}

/** そのプロジェクトで使うべきテストコマンドの案内(package.json の test スクリプトがあれば) */
export async function reviewerTestHint(cwd: string): Promise<string> {
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
  const project =
    typeof scripts.test === "string"
      ? ` This project defines a test script: run \`${runner} test\`.`
      : "";
  return `Bash may run only one test command at a time, already in the workspace; do not use cd or chain commands. Allowed: ${REVIEWER_COMMANDS.join(", ")}.${project}`;
}
