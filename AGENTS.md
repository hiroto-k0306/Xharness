# AGENTS.md — XHarness

このリポジトリで作業するコーディングエージェント(想定: Codex / sol、完全IDは現カタログで解決)向けの指示。人間の開発者も同じルールに従う。

## プロジェクト概要

XHarness は、Claude(Pro/Max)と GPT(ChatGPT Plus/Pro)の**サブスク枠**を直接使う、Windows 向けデスクトップ(Electron)の汎用コーディングエージェント。

- 現行仕様: [SPEC.md](SPEC.md)。**作業を始める前に、担当する節を必ず読むこと**
- 現行設計: [DESIGN.md](DESIGN.md)。旧仕様・未実装案は [Old索引](Old/README.md) に保存し、現行の実装要件として扱わない
- UI の見本: [mockup/index.html](mockup/index.html)(ブラウザで開くだけで見られる)
- モデル一覧: [catalog/models.yaml](catalog/models.yaml)
- ロゴ・アイコン: [brand/](brand/)
- 状態: GUI/headlessは同じ公式SessionController / OfficialWorkflowServiceとClaude SDK/Codex App Serverを使う。旧HTTPモデル通信・独自ツール実行・認証読込/ログイン/自動更新は通常経路から撤去する。旧履歴・手動管理・開発fixtureの存在を公式モデルへの機能提供と混同しない。機能差・未確認事項は [SPEC.md](SPEC.md) を参照する。過去のWindows配布/実通信の成功を最新リビジョンで再検証したものと扱わない。変更前の指示は [旧AGENTS](Old/AGENTS-6370866.md)

## 作業の進め方

1. 現行仕様と依頼の対象を照合し、最新コードでも課題が残っているか確認してから作業する。Oldの旧設計のフェーズ順を現在の作業制約にしない
2. 1つの作業は小さく区切る(目安: 1コミット = 1つの目的、差分 400 行以内)
3. SPEC.mdと違うことをしたくなったら、**実装する前に**理由と影響を書いて人間に確認する。確認が取れたらSPEC.mdも更新する。コードとの不一致を見つけても、無条件に仕様をコードへ合わせない
4. 調べて分かった事実(ヘッダ名、エラー形式など)は推測で埋めず、実際の通信結果を記録してから使う
5. 作業の最後に、何をして何が未完了かを短く報告する。テストが落ちている・試していないことは、そのまま書く
6. 結果はdocs/へ対象リビジョン・環境・検証範囲とともに記録する。過去の記録内のDESIGN.md参照は当時の根拠として残し、新しい仕様説明ではSPEC.mdを参照する

## ユーザーへのファイル・フォルダー案内

- ファイルやフォルダーの場所を案内するときは、**必ずクリックできる Markdown リンクを付ける**。生のパスやコードブロックだけで済ませない。
- Windows のローカルリンク先は `file:///D:/...` 形式の絶対 URL にする。`D:/...`、`D:\...`、相対パスをリンク先にしない（XHarness の表示側がローカルリンクとして扱えないため）。
- 例: `[インストーラーを開く](file:///D:/AIwork/XHarness-release/XHarness-0.0.0/XHarness-Setup-0.0.0.exe)`。フォルダーのリンク先は末尾 `/` を付ける。パスの各区分に含まれる空白と `( ) [ ] % ? #` は必ずパーセントエンコードする（ドライブ文字の `:` と区切りの `/` はそのままにする）。
- 成果物へのリンクは実在する最新の保存先を確認してから出す。この指定は、最終報告・途中報告・次の会話でも守る。
- リンクを開く際の確認や main 側の検証は従来どおり維持する。自動実行や安全設定の緩和で代用しない。

## 技術スタック(SPEC.md §2。勝手に変えない)

- Node.js 24 LTS（基準24.16.0、ユーザー環境に合わせて2026-10-03更新）/ TypeScript(`strict: true`)/ pnpm。Node 22.20以降も互換確認する
- Electron + electron-vite + electron-builder
- React + Zustand + CSS Modules
- Vitest / Playwright / ESLint / Prettier
- 実行シェル: PowerShell 7(Windows)
- Windows検証はユーザーが使うpwshの実体・配布形態まで合わせる。Codex同梱版だけで成功しても、WindowsApps / Store版での成功とみなさない。使用したNode・pwshの版と実体をdocs/へ記録する
- モデル実行: 公式Claude Agent SDK / Codex App Server。GUIとheadlessで同じ認証・通常枠・sandbox・承認境界を使い、旧HTTPへfallbackしない
- MCP SDKや旧検索の依存が互換処理に残っていても、通常の公式モデルへ旧ツールを公開する根拠にはしない

## 公式スキルの限定境界

- 4000文字参考資料送信と公式スキル選択を混同しない。固定provider root・登録workspace/会話所有範囲・既存PermissionGate・source/hash/bundleHashを選択/次workflow/各callで再検証する。
- bundleはmd/txt/rst最大20ファイル・全量16KiB。script/binary/hooks/agents/context fork/動的command等を有効化せず、省略して利用可能にしない。
- Claude通常nativeのplan/implement/review/fixだけを選択bundle限定local plugin/Skill gateへ接続する。settingSourcesや未選択plugin/MCPを有効化しない。Codex選択skill付きnativeは隔離未確認でApp Server起動前停止、両社実行成功と報告しない。
- requested/dispatched/observedの要求/許可/完了/拒否を分け、初期化・usageから実使用を推測しない。提供元の作成認定と扱わず、実通信検証は明示承認なしで行わない。[記録](docs/official-skills-20261009.md)。

## モデルpolicyと履歴

- 利用者の選択は世代なしprovider:aliasと独立effort。開始/安全再開/各call直前に現catalogで解決し、1通信中は実ID/effort/catalogを固定する。
- 旧IDのpolicy正規化は明示historicalIds/acceptedIds等の同じprovider/family対応だけを使う。文字列の類似・世代番号から推測せず、未知/競合/effort非対応/公式利用不能で停止し、fallbackしない。
- 過去の実ID・effort・catalog・plan・digestを書き換えない。policyとcall.modelSelectionを追記し、旧callの欠測証拠を現catalogで補わない。
- 新しい公式sessionの再開も既存安全checkpointだけ。alias更新を理由に不確定なquery/副作用を再送しない。CLIの旧履歴閲覧を無関係なdefault modelの不正で妨げず、新規/sendでは選択を検証する。
- Windows48件成功の根拠はfce9ebaの限定記録。今回alias改修のWindows/実モデル/GUI/配布成功へ読み替えない。前契約は [AGENTS-f7f7350](Old/AGENTS-f7f7350.md)、現行要件はSPEC §7/§15。

## コードのルール

- `src/main/` の core・providers・auth・tools・workflow・hooks は **electron を import しない**(UI なしでテストできるようにするため。SPEC.md §2)
- 公式SDK/App Serverの差は `src/main/workflow/official/` のAdapterに閉じ込める。モデル・認証・通常枠を送信前に照合し、未知・利用不能なら理由を示して停止する
- 旧HTTPや独自ツールをGUI/headlessの代替経路として復活させない。開発fixture、読み取り専用履歴、手動管理の境界を保つ
- 契約の解析・形式変換・承認境界の変更には、モック/fixtureを使う直接関連の単体テストを書く。思考や秘密を含むrawイベントをfixtureへ保存しない

## 絶対に守ること(セキュリティ)

- **アクセストークン・リフレッシュトークン・アカウント ID を、ログ・標準出力・ファイル・コミット・エラーメッセージに出さない**。出す必要があるときは先頭 6 文字 + `…` にマスクする
- `test/fixtures/` に保存するときは、リクエストヘッダの `Authorization` と `chatgpt-account-id` を必ず取り除く。保存前にマスク処理を通す
- 資格情報は公式基盤で扱う。XHarness側の直接資格情報読込、自前refresh、資格情報編集、期限の改変、秘密値の保存、アプリ内の旧ログイン/自動更新は追加しない
  - 認証が必要なら利用者が公式側でログインする。旧資料の認証更新許可を、現行の実行経路や開発試験の許可へ読み替えない
  - 製品機能の承認を、開発中の任意の実通信試験の許可に読み替えない。通常の検証はFakeProvider・モック・fixtureを使う。実通信は依頼で承認された範囲・回数だけ行い、結果を記録する
  - Phase 0〜5やstabilizeの過去の試験許可・通信予算は各docsの履歴であり、新しい作業の恒常的な通信許可ではない（[Phase 0](Old/docs/phase0-findings.md)、[stabilize](docs/stabilize-progress.md)）
- トークンをレンダラプロセス(画面側)に渡さない
- 使用量を無駄にしない: 承認された実試験も、指定された回数・軽いモデル・短い入力に限定する。未確認なら未確認と記録する

## コマンド

- この Windows 作業環境ではローカル pnpm（`.tools/node_modules/.bin/pnpm.cmd`）を使う。下記の `pnpm` は `.\scripts\pnpm.ps1` に置き換えて実行する（例: `.\scripts\pnpm.ps1 typecheck`）。子プロセスにもローカル版の PATH を引き継ぐ。グローバルへのインストールや永続 PATH 変更は不要。詳細は README.md の「この Windows 作業環境のローカル pnpm」。Linux や `.tools/` の無い環境では通常の pnpm を使う。

```bash
pnpm install
pnpm test          # Vitest
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit
pnpm dev:fake      # Electron を --fake(通信なし)で起動
pnpm headless      # GUIと同じ公式workflowのREPL
pnpm build:headless # headlessのビルド
pnpm build         # electron-vite でビルド
pnpm package       # exe を作る(手元の Windows で実行)
pnpm release       # exe を作り、配布に必要なファイルだけをリポジトリの外へ集める(手元の Windows で実行。README.md)
```

## クラウド環境(Linux)で作業する場合

Codex クラウドや Claude Code on the web など、Linux のクラウド環境で作業するときの追加ルール。

- **実 API へ通信しない**: Claude / ChatGPT のエンドポイントを呼ばない。確認は `test/fixtures/` の再生と `--fake`(FakeProvider)で行う
- **資格情報を要求・作成しない**: `~/.claude/.credentials.json` と `~/.codex/auth.json` を作らない・人間に貼らせない。無いことを前提にコードとテストを書く
- **PowerShell 依存のテストは実行しない**: Linux では `pwsh` が無く落ちるため、`it.skipIf` で除外する。手元(Windows)で必要な確認は、最後の報告に「手元で実施が必要」として列挙する
- **exe を作らない**: `electron-builder` による exe / インストーラの作成は手元で行う。クラウドでは `electron-vite build` が通るところまで確認する
- 既存の依存があるクラウドでpnpmの実体が指定版と異なる場合は、勝手にインストール・lockfile更新しない。今回のpnpm 11系は `exec` でも依存確認の自動インストールを試みるため、検証には `node node_modules/vitest/vitest.mjs`、`node node_modules/typescript/bin/tsc`、ESLint/Prettierのローカル実体を直接使う

## コミット

- メッセージは日本語可。形式: `<領域>: <やったこと>`(例: `spike(claude): ツール呼び出しの往復を確認`)
- 秘密情報を含むファイルがステージされていないか、コミット前に `git diff --cached` で確認する
