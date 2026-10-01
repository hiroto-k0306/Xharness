# XHarness

Phase 0 のゲートは2026-10-01に完了。Phase 1 は未着手。[検証結果と未実測事項](docs/phase0-findings.md)、[進捗](docs/phase0-progress.md)を参照。

Claude / Codex の OAuth 接続を検証する Windows 向けコーディングエージェント。
フォルダ名は `Xharness`、npm パッケージ名は `xharness`、アプリ名は設計書の `XHarness` を使用する。

## 現在の段階

Haiku のテキスト・ツール往復、Codex のテキスト・関数往復・暗号化推論返送、通常 effort、モデル一覧、使用量ヘッダ、ストリーム中断を確認済み。
期限切れは自前 refresh をせず公式 CLI に委ねる方針で確定。両 CLI 起動とその後の直接疎通も成功した。
トークンの実更新・期限切れエラーは未実測。Opus は2回とも429で、verified: false を維持。Ultra は承認により保留。

- 手順: [docs/phase0-runbook.md](docs/phase0-runbook.md)
- 設計: [DESIGN.md](DESIGN.md)
- 作業規則: [AGENTS.md](AGENTS.md)
- 進捗: [docs/phase0-progress.md](docs/phase0-progress.md)
- 実測: [docs/phase0-findings.md](docs/phase0-findings.md)
- Codex ソース調査: [docs/phase0-codex-source.md](docs/phase0-codex-source.md)

## 開発

Node.js 22（`.node-version`）、pnpm 10.34.6（`packageManager`）を使用する。
通常の Node.js 22 環境では次のコマンドで再現できる。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

この端末の既定 Node.js は 24 のため、今回の検証には git 管理外の `.tools/` に導入した Node.js 22 を使用した。
同じ環境で実行する場合は PowerShell の現在のセッションで次を設定する。

```powershell
$env:PATH = "$PWD\.tools\node_modules\node\bin;" + $env:PATH
node .tools/node_modules/pnpm/bin/pnpm.cjs test
node .tools/node_modules/pnpm/bin/pnpm.cjs typecheck
node .tools/node_modules/pnpm/bin/pnpm.cjs lint
```

## 共通部品の記録ルール

`record()` はローカル記録と fixtures の両方にマスク処理を適用する。
手順書 §2 の「生の内容」よりも AGENTS.md の秘密情報をファイルに出さない規則を優先し、
`spike/.out/` にも未加工のトークンを保存しない。

呼び出し側は認証に使用したトークン・アカウント ID を `options.secrets` に渡す。
ヘッダの認証情報は自動除去し、ネストしたオブジェクト・SSE の JSON 文字列・エラー本文へのコピーもマスクする。
秘密情報の短い値は全体を隠し、長い値は先頭6文字と `…` のみ残す。
既知のトークン使用数は非負の整数だけを保持する。組織・ワークスペースの識別ヘッダも除去する。

## 資格情報の検査（通信なし）

```powershell
pnpm spike:claude:creds
pnpm spike:codex:creds
```

資格情報ファイルは読み取り専用で、キー名・型と期限だけを表示する。
JWT のデコード結果は署名を検証しておらず、API 認証の成功を示すものではない。
OAuth アクセストークンが存在しない場合や読み取り失敗時は終了コード1を返す。

この端末の制限された実行環境で pnpm / tsx が起動できない場合は、次の方法で実行できる。
生成した JavaScript は git 管理外の `spike/.out/` に置く。資格情報は保存しない。

```powershell
.tools/node_modules/node/bin/node.exe node_modules/typescript/bin/tsc --noEmit false --rootDir spike --outDir spike/.out/compiled
.tools/node_modules/node/bin/node.exe spike/.out/compiled/claude/c1-creds.js
.tools/node_modules/node/bin/node.exe spike/.out/compiled/codex/x1-creds.js
```

## Claude の最小疎通と使用量

```powershell
pnpm spike:claude:text none
pnpm spike:claude:text custom
pnpm spike:claude:text none claude-opus-5-5
pnpm spike:claude:usage
```

text は1回につき1リクエスト。Haiku が既定で、出力上限64、固定プロンプト `Reply with the single word: pong` を使う。
引数は system の `none` / `identity` / `custom` と、手順書の Haiku / Opus のモデル ID。
usage は保存済みの Haiku ヘッダを読むだけで、通信しない。
コンパイルで実行する場合は上の tsc コマンドのあと、`spike/.out/compiled/claude/c2-text.js` / `c4-usage.js` を Node.js 22 に渡す。

試験予算の記録は `spike/.out/budget/` に保存する。Phase 0 完了まで削除せず、同じ失敗が2回続いたら停止して原因を調べる。

## ツール往復と Codex テキスト疎通

```powershell
pnpm spike:claude:tool
# 初回応答を保存済みで、結果返送だけ再開する場合
pnpm spike:claude:tool --resume-first
pnpm spike:codex:text
pnpm spike:codex:text gpt-6.1-sol
pnpm spike:codex:text gpt-6-astra
pnpm spike:codex:usage
```

Claude tool は通常2リクエスト、resume は保存済みの初回 SSE を使って1リクエスト。
Codex text は Luna が既定で1リクエスト、effort high、短い自前 instructions と固定の pong プロンプトを使う。
Codex usage は保存済みの3モデルのヘッダを読むだけで、通信しない。
Node.js 22 でコンパイルして実行する場合は、`spike/.out/compiled/claude/c3-tool.js`、`codex/x2-text.js`、`codex/x6-usage.js` を使う。

## Codex effort・関数往復・モデル一覧

```powershell
pnpm spike:codex:effort gpt-6.1-sol low
pnpm spike:codex:tool
pnpm spike:codex:tool max
pnpm spike:codex:models
```

effort は1回につき1リクエスト。モデルは Sol / Astra / Luna、値は low / medium / xhigh / max のみ。high は X2 を使う。
tool は Luna で2リクエスト、high が既定。max の記録は別の fixture に保存する。
models は GET 1回。掲載 effort と実際の呼び出し成功を区別する。raw ultra は、CLI が通常推論用の値に変換するため試験対象にしていない。

## ストリーム中断

```powershell
pnpm spike:claude:abort
pnpm spike:codex:abort
```

各1リクエスト。Haiku / Luna low で最初の SSE イベントを受け取ったら AbortController を発火し、部分イベントと例外の種類を保存する。
例外メッセージとスタックは保存しない。実際の Ctrl+C キー操作・tool 実行の中断とは別の通信試験。

## 暗号化推論の返送・公式 CLI 更新試験

```powershell
pnpm spike:codex:encrypted-replay
pnpm spike:cli:refresh claude C:/Users/ahwri/.local/bin/claude.exe
```

encrypted-replay は保存済み X4 Luna max 応答を次ターンに返す1リクエストの試験。
cli:refresh は provider と実行ファイルのパスを受け取り、短い pong で公式 CLI を1回起動する。codex も指定できる。
公式 CLI が資格情報を更新することはユーザー承認済み。スクリプトは前後をメモリで比較し、秘密値と CLI 生出力を保存しない。
期限前で値が変わらなければ更新の実測にはならない。CLI 内部の HTTP 回数も観測していない。
