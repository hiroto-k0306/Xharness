# XHarness(開発用)

Claude(Pro / Max)と ChatGPT(Plus / Pro)のサブスクリプションの枠を直接使う、Windows 向けのデスクトップ(Electron)のコーディングエージェント。

このファイルは**開発者向け**。アプリを使う人向けの説明(インストール・起動・使い方)は [release/README.md](release/README.md) にあり、配布物に同梱する。

## 現在の仕様と状態

作業前に [SPEC.md](SPEC.md) の担当節と [AGENTS.md](AGENTS.md) を読む。現行仕様はSPEC.mdへ集約し、DESIGN.mdは過去の設計資料として保存する。過去のフェーズ順や未実装案を、そのまま現在の実装要件にはしない。

デスクトップ・headless、workflow、MCP、実行レポート、巻き戻し、画像、子の引き継ぎ・予約などを実装済み。デスクトップには公式CLIによる認証自動更新もあるが、headlessとは機能差がある。動作・設定・未確認事項は [SPEC.md](SPEC.md) を参照する。

Windowsのexe作成・fake GUIの記録は [20261004配布記録](docs/release-20261004-integrated.md)。その後の [認証更新記録](docs/auth-refresh-progress.md) は型・lint・buildと150ファイル / 1445テストの成功を記録しているが、実際の期限切れでの更新は未確認。以前の配布物に最新ソースの変更が入っているとは限らない。

## 資料

できることを一覧で探す場合は [機能一覧（FEATURES.md）](FEATURES.md) を参照する。用途・操作方法・デスクトップとheadlessの違いをまとめている。

| 資料                                          | 内容                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| [SPEC.md](SPEC.md)                            | 現行仕様・既定値・機能差・検証範囲(作業前に担当節を読む)     |
| [DESIGN.md](DESIGN.md)                        | 過去の設計と検討経緯。現行仕様として使わない                 |
| [AGENTS.md](AGENTS.md)                        | 作業の規則(セキュリティ・コミット・クラウドでの制約)         |
| [release/README.md](release/README.md)        | 利用者向けの README(配布物に同梱)                            |
| [docs/](docs/)                                | 日付・対象リビジョンごとの進捗と検証記録                     |
| [品質・使用量の評価](docs/task-evaluation.md) | タスク評価、品質優先の同条件比較、固定オフライン課題の再実行 |
| [mockup/index.html](mockup/index.html)        | 初期の画面見本。現在の画面仕様はSPEC.mdを参照                |
| [catalog/models.yaml](catalog/models.yaml)    | モデルの一覧                                                 |

## 開発環境

- Node.js 24 LTS（基準24.16.0、`.node-version`）、pnpm 10(`packageManager`)。Node 22.20以降も互換確認対象
- Windowsのシェル実行にはPowerShell 7(`pwsh`)、リポジトリ操作にはGitが必要。ripgrep(`rg`)は推奨だが、省略時もGrep / GlobはNode検索へ切り替わる
- Windowsの検証ではNodeとpwshの版・実体を確認する（`node --version`、`Get-Command node,pwsh`、`pwsh -NoProfile -Command '$PSVersionTable.PSVersion'`）。Codex同梱pwshとWindowsApps版は子プロセスのJob継承が異なる場合があるため、ユーザーと同じpwshをPATHの先頭に指定する。切り分けは [docs/h3-job-investigation.md](docs/h3-job-investigation.md)
- 通常の検証はFakeProvider・モック・`test/fixtures/`を使う。実モデル・認証CLI・spikeの実行は別途承認された範囲のみ。公式CLIのログインが必要な実試験や、更新によるモデル通信を無断で行わない。クラウド(Linux)では実APIを呼ばない([AGENTS.md](AGENTS.md))

### この Windows 作業環境のローカル pnpm

この作業環境には `.tools\node_modules\.bin\pnpm.cmd`（10.34.6）がインストール済み。Windows では以下のラッパーを使い、グローバルの PATH に依存せずローカル版を参照する。

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

通常の `pnpm test` は、Windows の PowerShell / Git 系テストで並列実行時のタイムアウトが再発したため、直列（`--maxWorkers=1`）・各テスト30秒制限を既定とする。既定の並列実行が安定したという意味ではない。

## GUI を操作して確認する(開発用)

```powershell
.\scripts\pnpm.ps1 test:gui
```

Playwright で開発版 XHarness を専用の一時領域に `--fake` 起動し、初期表示、scratch の ping/pong、Transcript / LoopFlow の切替を操作・撮影する。実 API や資格情報は使わず、終了時に専用プロセスと一時データを片付ける。Playwright 用ブラウザの追加インストールは不要。

画像は `.out/gui/` に保存する。通常の `pnpm test`(Vitest)とは別実行。手順・安全上の境界・Windows の実測は [docs/gui-testing.md](docs/gui-testing.md)。他のアプリの操作や、XHarness エージェントへのデスクトップ操作権限の追加ではない。

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

## リポジトリの構成

| 場所                          | 内容                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `src/main/`                   | main プロセス(エージェント・プロバイダ・ツール・MCP・セッション)                        |
| `src/renderer/`               | 画面(React)                                                                             |
| `src/preload/`、`src/shared/` | IPC の受け渡しと共通の型                                                                |
| `src/headless.ts`             | 画面なしの REPL                                                                         |
| `test/fixtures/`              | 実通信の録画(秘密値は除去済み)と試験用の MCP サーバー                                   |
| `spike/`                      | 実通信の確認スクリプト(Phase 0 の記録は [docs/phase0-spikes.md](docs/phase0-spikes.md)) |
| `scripts/`                    | アイコン生成・配布物の収集                                                              |
| `release/`                    | 配布物に同梱するファイル                                                                |
| `brand/`、`resources/`        | ロゴ・アイコン                                                                          |
