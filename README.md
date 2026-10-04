# XHarness(開発用)

Claude(Pro / Max)と ChatGPT(Plus / Pro)のサブスクリプションの枠を直接使う、Windows 向けのデスクトップ(Electron)のコーディングエージェント。

このファイルは**開発者向け**。アプリを使う人向けの説明(インストール・起動・使い方)は [release/README.md](release/README.md) にあり、配布物に同梱する。

## 資料

| 資料                                       | 内容                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| [DESIGN.md](DESIGN.md)                     | 全体設計(作業前に担当する節を読む)                   |
| [AGENTS.md](AGENTS.md)                     | 作業の規則(セキュリティ・コミット・クラウドでの制約) |
| [release/README.md](release/README.md)     | 利用者向けの README(配布物に同梱)                    |
| [docs/](docs/)                             | フェーズごとの進捗と手元確認の記録                   |
| [mockup/index.html](mockup/index.html)     | 画面の見本                                           |
| [catalog/models.yaml](catalog/models.yaml) | モデルの一覧                                         |

## 開発環境

- Node.js 24 LTS（基準24.16.0、`.node-version`）、pnpm 10(`packageManager`)。Node 22.20以降も互換確認対象
- Windows で動かす場合: PowerShell 7(`pwsh`)、ripgrep(`rg`)、Git
- Windowsの検証ではNodeとpwshの版・実体を確認する（`node --version`、`Get-Command node,pwsh`、`pwsh -NoProfile -Command '$PSVersionTable.PSVersion'`）。Codex同梱pwshとWindowsApps版は子プロセスのJob継承が異なる場合があるため、ユーザーと同じpwshをPATHの先頭に指定する。切り分けは [docs/h3-job-investigation.md](docs/h3-job-investigation.md)
- 実際のモデルを使う確認には、公式 CLI(`claude` / `codex`)でのログインが要る。クラウド(Linux)では実 API を呼ばず、`--fake` と `test/fixtures/` で確認する(AGENTS.md)

### この Windows 作業環境のローカル pnpm

この作業環境には `.tools\node_modules\.bin\pnpm.cmd`（10.34.6）がインストール済み。Windows では以下のラッパーを使い、グローバルの PATH に依存せずローカル版を参照する。

```powershell
.\scripts\pnpm.ps1 --version
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 test --maxWorkers=4
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
