# 開発・検証・配布の操作案内

現行の動作契約は [Spec](Spec.md)、開発原則は [AGENTS](../AGENTS.md)。以下は操作手順であり、試験成功の記録は各reportで別に管理します。

## 開発環境

- Node.js 24 LTS（基準24.16.0、`.node-version`）、pnpm 10(`packageManager`)。Node 22.20以降も互換確認対象
- Windowsの公式ヘルパー起動にはPowerShell 7(`pwsh`)、リポジトリ操作にはGitが必要。モデルの探索・編集・コマンド実行は公式基盤のツールを使う。旧独自Grep/GlobのNode代替検索を通常経路の保証にしない
- Windowsの検証ではNodeとpwshの版・実体を確認する（`node --version`、`Get-Command node,pwsh`、`pwsh -NoProfile -Command '$PSVersionTable.PSVersion'`）。Codex同梱pwshとWindowsApps版は子プロセスのJob継承が異なる場合があるため、ユーザーと同じpwshをPATHの先頭に指定する。切り分けは [docs/h3-job-investigation.md](report/h3-job-investigation.md)
- 通常の検証はFakeProvider・モック・`test/fixtures/`を使う。実モデル・公式CLIによる認証操作は別途承認された範囲のみ。過去の認証更新・spikeの成功記録を新たな実通信の許可にしない。クラウド(Linux)では実APIを呼ばない([AGENTS.md](../AGENTS.md))

### この Windows 作業環境のローカル pnpm

過去のWindows検証環境では `.tools\node_modules\.bin\pnpm.cmd`（10.34.6）を使用しました。現在のcheckoutや別PCに存在する保証ではありません。用意済みのWindows環境では以下のラッパーでローカル版を参照できます。

```powershell
.\scripts\pnpm.ps1 --version
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 test
.\scripts\pnpm.ps1 release
```

以下の手順の `pnpm` は、この環境では `.\scripts\pnpm.ps1` に置き換える。ラッパーは実行中だけローカルの bin を PATH の先頭へ追加するため、electron-builder などの子プロセスも同じ pnpm を使用する。終了コードを引き継ぎ、終了時に PATH を戻す。ユーザー・システムの PATH や PowerShell プロファイルは変更しない。

`.tools/` はローカル環境用で、新規 clone には含まれない。無い環境では pnpm 10.34.6 を別途用意して通常の `pnpm` コマンドを使う（ラッパーは自動インストールや他の版へのフォールバックを行わない）。

```powershell
pnpm install --frozen-lockfile
pnpm test          # Vitest
pnpm typecheck
pnpm lint
pnpm format:check
pnpm dev:fake      # Electron を通信なしで起動
pnpm build         # electron-vite でビルド
pnpm headless      # 画面なしの REPL(tsx)
```

通常の `pnpm test` は、Windows の PowerShell / Git 系テストで並列実行時のタイムアウトが再発したため、直列（`--maxWorkers=1`）・各テスト30秒制限を既定とする（模擬DAGの統合レビュー修正1ケースのみ60秒）。既定の並列実行が安定したという意味ではない。

## Headless（公式経路）

`pnpm headless -- --cwd <作業フォルダー> --codex-path <codex実行ファイル>`、または `pnpm build:headless` 後の `node dist/headless.js` で起動する。公式Claude SDK / Codex App Server、モデルカタログ、計画・操作承認、直接編集、別会社レビューはGUIと同じサービスを使う。承認はTTYでのみ受け付け、非対話入力で承認が必要なら停止する。非WindowsでWindowsのプロセス隔離まで動作確認したとは扱わない。

`--help` で最新の引数を確認する。`/help`、`/exit`、`/stop`、`/model`、`/mode`、`/resume`、`/clear`、`/history`、`/workflow` は端末操作であり、旧独自ツールをモデルへ公開するものではない。GUI入力の旧slash対応とは異なる。旧履歴を公式会話へ自動転送しない。`--report <sessionId> --output <新規HTML>` と `--replay <sessionId>` は読み取り専用でモデルを起動しない。

## GUI を操作して確認する(開発用)

```powershell
.\scripts\pnpm.ps1 test:gui
```

Playwright で開発版 XHarness を専用の一時領域に `--fake` 起動し、現在のsmokeは初期表示・入力欄・保存先隔離・preload APIとrendererのNode隔離を確認し、startup画像を撮影する。過去のping/pong・LoopFlow検証とは対象が異なる。実 API や資格情報は使わず、終了時に専用プロセスと一時データを片付ける。Playwright 用ブラウザの追加インストールは不要。

画像は `.out/gui/` に保存する。通常の `pnpm test`(Vitest)とは別実行。境界は [fixture](../test/gui/electron.fixture.ts)、確認対象は [smoke](../test/gui/smoke.spec.ts) と [設定](../playwright.config.ts) を参照。過去のWindows実測は [2026-10-04の記録](report/gui-testing-20261004.md)。他のアプリの操作や、XHarness エージェントへのデスクトップ操作権限の追加ではない。

## 配布物を作って保管する(手元の Windows)

```powershell
pnpm release
```

`pnpm package` で exe を作り、配布に必要なファイルだけを**リポジトリの外**に集める。

```
..\XHarness-release\XHarness-<版>\
  XHarness-Setup-<版>.exe      インストーラ版
  XHarness-<版>-portable.exe   ポータブル版
  README.md                    利用者向けの説明(release/README.md の写し)
  SHA256SUMS.txt               ハッシュ値
```

- 作成済みの exe を集めるだけなら `pnpm release:collect`。保存先は `pnpm release:collect -- --out D:\XHarness-release` で変えられる
- 同じ版のフォルダが既にあれば上書きしない(保管した版を守るため)。作り直すときは `--force`、または `package.json` の `version` を上げる
- リポジトリの中には保存しない(exe を誤ってコミットしないため)
- `dist/` には exe 以外(展開版・headless のビルド結果)も入るが、集めるのは上の2つの exe だけ

統合版の実exe起動・再起動・異常終了後の停止・ポータブル分離の検証と、既存アプリ保全のため未実行にしたインストーラー更新は [最終配布検証](report/release/integrated-release-validation-20261005.md) を参照。

## リポジトリの構成

| 場所                                                     | 内容                                                   |
| -------------------------------------------------------- | ------------------------------------------------------ |
| `src/main/`                                              | 公式workflow・セッション・保存・認証境界と互換用の実装 |
| `src/renderer/`                                          | 画面(React)                                            |
| `src/preload/`、`src/shared/`                            | IPC の受け渡しと共通の型                               |
| `src/headless.ts`                                        | 公式経路の画面なしREPL（GUIと同じworkflow）            |
| `test/fixtures/`                                         | 実通信の録画(秘密値は除去済み)と現行テストfixture      |
| [Old/retired-sources/](../Old/retired-sources/README.md) | 廃止済みソース・旧spikeの保存庫。実行対象外            |
| `scripts/`                                               | アイコン生成・配布物の収集                             |
| `release/`                                               | 配布物に同梱するファイル                               |
| `brand/`、`resources/`                                   | ロゴ・アイコン                                         |

最新aliasの追従方針と限定検証は [実装記録](report/latest-alias-policy-20261009.md) を参照。
