// Bash ツール(PowerShell 7)に渡すコマンド文字列を、権限判定のために保守的に調べる。
// PowerShell の構文を完全には解析しない。判断できない形は「単純でない」として必ず確認に回す。

export interface CommandShape {
  /** 1つのコマンドだけで、入れ子の実行・連結・リダイレクトを含まない */
  simple: boolean;
  /** 空白区切りの語(引用符は外す)。simple でないときも参考に返す */
  tokens: string[];
  /** 別プログラムを起動させうるオプション(git -c、rg --pre など)を含む */
  riskyOption: boolean;
  /** 作業フォルダの外を指しうる引数(絶対パス・~・..・UNC)を含む */
  outsidePath: boolean;
}

/**
 * 連結(; | & && ||)、リダイレクト(> <)、改行、変数・式展開($ `)、
 * 部分式・スクリプトブロック(( ) { } @( ))、呼び出し演算子・ドットソース、`--%` を含む形は単純でない。
 * `git status (Remove-Item …)` のような括弧の中も PowerShell では実行されるため。
 */
const NOT_SIMPLE = /[;|&<>\r\n$`(){}]|--%/;

/** 別のプログラムやコマンド行を実行させうるオプション */
const RISKY_OPTIONS =
  /^(?:-c|-C|--config-env(?:=.*)?|--exec(?:-path)?(?:=.*)?|--upload-pack(?:=.*)?|--receive-pack(?:=.*)?|--ext-diff|--textconv|--output(?:=.*)?|--pre(?:=.*)?|--pre-glob(?:=.*)?|-z|--search-zip|--hostname-bin(?:=.*)?)$/;

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function pointsOutside(token: string): boolean {
  // `-Path:C:\x` や `--file=/etc/x` のような値付きオプションも見る
  const value = token.replace(/^-{1,2}[\w-]+[:=]/, "");
  return (
    /^[A-Za-z]:[\\/]?/.test(value) ||
    /^[\\/]/.test(value) ||
    /^~/.test(value) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value) ||
    /^[A-Za-z]+:/.test(value) // env: / HKLM: / HKCU: などの PowerShell ドライブ
  );
}

export function analyzeCommand(command: string): CommandShape {
  const tokens = tokenize(command);
  const first = tokens[0] ?? "";
  const simple =
    !!command.trim() &&
    !NOT_SIMPLE.test(command) &&
    // ドットソース(. ./x.ps1)は別スクリプトをこのシェルで実行する
    first !== "." &&
    // 閉じていない引用符は解釈が定まらない
    (command.match(/'/g) ?? []).length % 2 === 0 &&
    (command.match(/"/g) ?? []).length % 2 === 0;
  return {
    simple,
    tokens,
    riskyOption: tokens.slice(1).some((t) => RISKY_OPTIONS.test(t)),
    outsidePath: tokens.slice(1).some(pointsOutside),
  };
}

/**
 * deny / ask ルールを当てるための部分コマンド。連結や括弧の中のコマンドも対象にする
 * (Claude Code と同じく、制限するルールはどの部分に一致しても効く)。
 */
export function subcommands(command: string): string[] {
  return command
    .split(/[;|&\r\n(){}]+|\$\(|@\(/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 「常に許可」で保存する Bash ルール。先頭の語だけでなく、サブコマンドまで含めて狭く保存する */
export function bashGrantPattern(command: string): string {
  const shape = analyzeCommand(command);
  const [first = "", second] = shape.tokens;
  // 単純でない・危険なオプションを含む形は、ルールでは許可されない。完全一致で保存しておく
  if (!shape.simple || shape.riskyOption) return command.trim();
  if (shape.tokens.length === 1) return first;
  // 引用符を外した語を保存すると、元のコマンド文字列に一致しなくなる。
  const rawPrefix = command.trim().match(/^(\S+)\s+([A-Za-z][\w.:-]*)(?=\s|$)/);
  if (
    second &&
    rawPrefix?.[1] === first &&
    rawPrefix[2] === second &&
    !pointsOutside(second)
  )
    return `${first} ${second} *`;
  return command.trim();
}
