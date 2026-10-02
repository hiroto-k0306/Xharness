// 秘密情報を含みうるファイルと、書き込みを自動承認しない保護パス(Claude Code の protected paths に準拠)。

const SECRET_FILE =
  /^(?:\.env(?:\..*)?|auth\.json|\.credentials\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.pgpass|.*\.(?:pem|key|p12|pfx|keystore|jks))$/i;

function parts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** §A6: 読み取りに必ず確認を求める秘密ファイル(またはその中)か */
export function isSecretPath(path: string): boolean {
  const segments = parts(path);
  const name = segments.at(-1) ?? "";
  if (SECRET_FILE.test(name)) return true;
  const lower = segments.map((s) => s.toLowerCase());
  const has = (dir: string, file?: string) => {
    const i = lower.lastIndexOf(dir);
    return i >= 0 && (file === undefined || lower[i + 1] === file);
  };
  return (
    has(".ssh") ||
    has(".gnupg") ||
    has(".aws") ||
    has(".azure") ||
    has(".kube", "config") ||
    has(".docker", "config.json") ||
    (has("gcloud") && /credentials|tokens|\.db$/i.test(name))
  );
}

const PROTECTED_DIRS = new Set([
  ".git",
  ".xharness",
  ".claude",
  ".vscode",
  ".idea",
  ".husky",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);
const PROTECTED_FILES = new Set([
  ".gitconfig",
  ".gitmodules",
  ".gitattributes",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_aliases",
  ".bash_logout",
  ".zshrc",
  ".zprofile",
  ".zshenv",
  ".zlogin",
  ".zlogout",
  ".profile",
  ".envrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  ".pnp.loader.mjs",
  ".pnpmfile.cjs",
  "bunfig.toml",
  ".bunfig.toml",
  ".bazelrc",
  ".bazelversion",
  ".bazeliskrc",
  ".pre-commit-config.yaml",
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
  "gradle-wrapper.properties",
  "maven-wrapper.properties",
  ".devcontainer.json",
  ".ripgreprc",
  "pyrightconfig.json",
  ".mcp.json",
  ".claude.json",
  "microsoft.powershell_profile.ps1",
  "profile.ps1",
]);

/**
 * 書き込みを自動承認しない保護パスか(リポジトリの状態・ツールの設定・シェルの起動設定)。
 * allow ルールや acceptEdits でも確認を求める。
 */
export function isProtectedPath(path: string): boolean {
  const segments = parts(path).map((s) => s.toLowerCase());
  const name = segments.at(-1) ?? "";
  if (PROTECTED_FILES.has(name)) return true;
  if (segments.slice(0, -1).some((s) => PROTECTED_DIRS.has(s))) return true;
  if (PROTECTED_DIRS.has(name)) return true;
  const i = segments.lastIndexOf(".config");
  return i >= 0 && segments[i + 1] === "git";
}
