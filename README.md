# XHarness(開発用)

Claude(Pro / Max)と ChatGPT(Plus / Pro)のサブスクリプションの枠を直接使う、Windows 向けのデスクトップ(Electron)のコーディングエージェント。

このファイルは**開発者向け**。アプリを使う人向けの説明(インストール・起動・使い方)は [release/README.md](release/README.md) にあり、配布物に同梱する。

## チャット承認と通知

計画/操作の承認は対応する会話のチャットで行います。Windowsでは承認/入力待ちと終了/停止を固定文面で通知し、クリックで該当会話へ移動します。通知は許可操作ではなく、非対応/失敗でも処理を妨げません。実Windows表示は未確認。通常workflow専用画面は通常UIから撤去し、接続設定は設定、全保存証跡は会話のReceipts、rewind確認もチャット内へ配置します。[範囲と検証記録](docs/chat-approvals-notifications-20261009.md)。

## 並列判断と限定DAG

通常作業の計画は直列/並列の理由と条件を決めます。並列の実装はclean Git・exact scope・所有worktree・最大2並行に限定しますが、本番の安全な独立検証portが未確認のため計画承認/実装前に停止します。模擬agents+real Git+固定Node検証は本番実行成功ではありません。質問はこの判断経路を通りません。[現在の範囲](docs/chat-layout-native-dag-20261009.md)。

## 公式スキルと参考資料

「公式スキル」は固定provider rootの候補を既存許可でプレビュー・明示選択します。Claude通常nativeのplan/implement/review/fixだけを選択bundle限定のSDK Skill機構へ接続します。Codexは列挙/選択可能ですがnative実行は隔離未確認のためApp Server起動前に停止します。質問/固定scope/模擬DAGは未対応。md/txt/rst最大20ファイル・全量16KiBのみで、script/hooks/agents/動的command等は停止します。4000文字参考資料sendとは別で、自動置換・権限緩和をしません。実モデル/実CLI成功は未確認。[詳細と証跡](docs/official-skills-20261009.md)。

## モデルaliasの最新追従

選択は世代なし `provider:alias`（opus/sonnet/haiku/astra/sol/luna）と別のeffortです。開始・安全再開・各モデル通信直前に現カタログから完全IDを解決し、その1通信中は固定します。旧IDは明示historicalIds等の同じ会社/family対応だけで将来の選択policyへ正規化します。過去の実ID/effort/catalog/plan/digestを変えず、各callに今回のpolicy/実ID・変更有無を追記します。

未知/競合・effort非対応・公式利用不能は理由付き停止とし、別モデルやeffortへfallbackしません。CLI履歴resumeは無関係な既定モデルが無効でも読めますが、新規会話/送信は選択aliasを検証します。安全checkpointの条件と不確定な副作用の再送禁止を維持します。詳細は [SPEC §7](SPEC.md#7-モデル選択policy最新alias使用量)。変更前入口は [README-f7f7350](Old/README-f7f7350.md)。

[Windows限定48件成功](docs/windows-pr26-validation-20261009.md)はfce9ebaの結果で、今回alias改修のWindows/実モデル/GUI/配布検証ではありません。

## 現在の仕様と状態

作業前に [SPEC.md](SPEC.md) の担当節と [AGENTS.md](AGENTS.md) を読む。現行仕様はSPEC.md、現行設計はDESIGN.mdへ集約する。更新前の仕様・設計・機能一覧と初期履歴は [Old索引](Old/README.md) に保存する。過去のフェーズ順や未実装案を、そのまま現在の実装要件にはしない。

GUIとheadlessは同じSessionController / OfficialWorkflowServiceから、公式Claude Agent SDK / Codex App Serverで質問判別、探索・計画、承認、実装・テスト報告、別会社レビューと修正を行う。旧HTTPモデル通信・独自ツール実行・アプリ内の資格情報読込/ログイン/自動更新は通常の実行経路から撤去する。旧MCP・Web・子委託・画像送信・巻き戻し・予約の操作を公式モデルへ転送しない。保存済み履歴の閲覧とレポート出力は残す。動作・設定・未確認事項は [SPEC.md](SPEC.md) を参照する。

変更前の使い方・開発指示は [旧README](Old/README-6370866.md)、[旧AGENTS](Old/AGENTS-6370866.md)、[旧配布README](Old/release-README-6370866.md) に保存する。旧資料は過去の対応範囲であり、現行の操作手順ではない。

最新の参照は [公式移行回帰の修復（関連69成功）](docs/official-migration-regression-fix-20261009.md)、[残存2件の修正と全回帰（当時52失敗）](docs/remaining-failures-regression-20261009.md)、[公式共通化・旧実行器整理](docs/official-only-consolidation-20261009.md)、[文書照合記録](docs/documentation-refresh-20261009.md)、[環境修正後の実アプリ](docs/workflow-environment-fix-live-20261009.md)、[過去の全回帰（1件timeout）](docs/full-regression-20261009.md)、[PR #25の限定確認](docs/catalog-timeout-fix-20261009.md)。最新mainのWindows配布を今回再検証したものではない。

過去のWindowsのexe作成・fake GUIの記録は [20261004配布記録](docs/release-20261004-integrated.md)。以前の配布物に今回のGUI/headless共通化や旧経路撤去が入っているとは限らない。今回のWindows配布・インストール・実モデル通信の再検証は未実施。

## 資料

できることを一覧で探す場合は [機能一覧（FEATURES.md）](FEATURES.md) を参照する。対応範囲・操作方法・検証の限界をまとめている。

実画面入りの [紹介資料（PowerPoint／HTMLプレビュー）](docs/presentations/20261008/README.md) も用意している。保存済みのテスト画面を使い、対応範囲と未確認事項を含めて紹介する。

| 資料                                          | 内容                                                         |
| --------------------------------------------- | ------------------------------------------------------------ |
| [SPEC.md](SPEC.md)                            | 現行仕様・既定値・機能差・検証範囲(作業前に担当節を読む)     |
| [DESIGN.md](DESIGN.md)                        | 現行アーキテクチャと経路・保存・承認境界                     |
| [Old索引](Old/README.md)                      | 更新前仕様・設計・機能一覧、過去資料の移動対応               |
| [AGENTS.md](AGENTS.md)                        | 作業の規則(セキュリティ・コミット・クラウドでの制約)         |
| [release/README.md](release/README.md)        | 利用者向けの README(配布物に同梱)                            |
| [docs/](docs/)                                | 日付・対象リビジョンごとの進捗と検証記録                     |
| [品質・使用量の評価](docs/task-evaluation.md) | タスク評価、品質優先の同条件比較、固定オフライン課題の再実行 |
| [mockup/index.html](mockup/index.html)        | 初期の画面見本。現在の画面仕様はSPEC.mdを参照                |
| [catalog/models.yaml](catalog/models.yaml)    | モデルの一覧                                                 |

## 開発環境

- Node.js 24 LTS（基準24.16.0、`.node-version`）、pnpm 10(`packageManager`)。Node 22.20以降も互換確認対象
- Windowsの公式ヘルパー起動にはPowerShell 7(`pwsh`)、リポジトリ操作にはGitが必要。モデルの探索・編集・コマンド実行は公式基盤のツールを使う。旧独自Grep/GlobのNode代替検索を通常経路の保証にしない
- Windowsの検証ではNodeとpwshの版・実体を確認する（`node --version`、`Get-Command node,pwsh`、`pwsh -NoProfile -Command '$PSVersionTable.PSVersion'`）。Codex同梱pwshとWindowsApps版は子プロセスのJob継承が異なる場合があるため、ユーザーと同じpwshをPATHの先頭に指定する。切り分けは [docs/h3-job-investigation.md](docs/h3-job-investigation.md)
- 通常の検証はFakeProvider・モック・`test/fixtures/`を使う。実モデル・公式CLIによる認証操作は別途承認された範囲のみ。過去の認証更新・spikeの成功記録を新たな実通信の許可にしない。クラウド(Linux)では実APIを呼ばない([AGENTS.md](AGENTS.md))

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

通常の `pnpm test` は、Windows の PowerShell / Git 系テストで並列実行時のタイムアウトが再発したため、直列（`--maxWorkers=1`）・各テスト30秒制限を既定とする（模擬DAGの統合レビュー修正1ケースのみ60秒）。既定の並列実行が安定したという意味ではない。

## Headless（公式経路）

`pnpm headless -- --cwd <作業フォルダー> --codex-path <codex実行ファイル>`、または `pnpm build:headless` 後の `node dist/headless.js` で起動する。公式Claude SDK / Codex App Server、モデルカタログ、計画・操作承認、直接編集、別会社レビューはGUIと同じサービスを使う。承認はTTYでのみ受け付け、非対話入力で承認が必要なら停止する。非WindowsでWindowsのプロセス隔離まで動作確認したとは扱わない。

`--help` で最新の引数を確認する。`/help`、`/exit`、`/stop`、`/model`、`/mode`、`/resume`、`/clear`、`/history`、`/workflow` は端末操作であり、旧独自ツールをモデルへ公開するものではない。GUI入力の旧slash対応とは異なる。旧履歴を公式会話へ自動転送しない。`--report <sessionId> --output <新規HTML>` と `--replay <sessionId>` は読み取り専用でモデルを起動しない。

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

統合版の実exe起動・再起動・異常終了後の停止・ポータブル分離の検証と、既存アプリ保全のため未実行にしたインストーラー更新は [最終配布検証](docs/integrated-release-validation-20261005.md) を参照。

## リポジトリの構成

| 場所                                                  | 内容                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `src/main/`                                           | 公式workflow・セッション・保存・認証境界と互換用の実装 |
| `src/renderer/`                                       | 画面(React)                                            |
| `src/preload/`、`src/shared/`                         | IPC の受け渡しと共通の型                               |
| `src/headless.ts`                                     | 公式経路の画面なしREPL（GUIと同じworkflow）            |
| `test/fixtures/`                                      | 実通信の録画(秘密値は除去済み)と現行テストfixture      |
| [Old/retired-sources/](Old/retired-sources/README.md) | 廃止済みソース・旧spikeの保存庫。実行対象外            |
| `scripts/`                                            | アイコン生成・配布物の収集                             |
| `release/`                                            | 配布物に同梱するファイル                               |
| `brand/`、`resources/`                                | ロゴ・アイコン                                         |

最新aliasの追従方針と限定検証は [実装記録](docs/latest-alias-policy-20261009.md) を参照。
