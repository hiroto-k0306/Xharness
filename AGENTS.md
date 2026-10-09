# AGENTS.md — XHarness

このリポジトリで作業するコーディングエージェント(想定: Codex / GPT-6.1 Sol)向けの指示。人間の開発者も同じルールに従う。

## プロジェクト概要

XHarness は、Claude(Pro/Max)と GPT(ChatGPT Plus/Pro)の**サブスク枠**を直接使う、Windows 向けデスクトップ(Electron)の汎用コーディングエージェント。

- 現行仕様: [SPEC.md](SPEC.md)。**作業を始める前に、担当する節を必ず読むこと**
- 現行設計: [DESIGN.md](DESIGN.md)。旧仕様・未実装案は [Old索引](Old/README.md) に保存し、現行の実装要件として扱わない
- UI の見本: [mockup/index.html](mockup/index.html)(ブラウザで開くだけで見られる)
- モデル一覧: [catalog/models.yaml](catalog/models.yaml)
- ロゴ・アイコン: [brand/](brand/)
- 状態: デスクトップ通常入力は公式Claude SDK/Codex App Server。旧HTTP/headlessに残るMCP・汎用ツール・予約・認証自動更新を通常desktopの対応機能と混同しない。機能差・未確認事項は [SPEC.md](SPEC.md) を参照する。Windows配布物の作成記録は [docs/release-20261004-integrated.md](docs/release-20261004-integrated.md)、その後の認証更新の検証は [docs/auth-refresh-progress.md](docs/auth-refresh-progress.md)。過去の成功を現在のリビジョンで再検証したものと扱わない

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
- MCP クライアント: 公式 `@modelcontextprotocol/sdk`(ユーザー承認済み。SPEC.md §9。旧HTTP Adapterのモデル API 呼び出しは標準fetch。desktop通常経路は公式Claude Agent SDK/Codex App Serverを使う（SPEC.md §15）)
- Node代替検索: `ignore` と `node:path.matchesGlob` は採用承認済み。rgがない場合も動作を確認する

## コードのルール

- `src/main/` の core・providers・auth・tools・workflow・hooks は **electron を import しない**(UI なしでテストできるようにするため。SPEC.md §2)
- プロバイダごとの違い(HTTP・SSE・形式変換)は `src/main/providers/<provider>/` の中に閉じ込める。Agent Loop は `ProviderEvent` だけを見る(SPEC.md §2)
- 旧HTTP Adapterのモデル API 呼び出しには Node 標準の `fetch` を使う。通常desktopの公式Claude Agent SDK/Codex App Serverと、公式MCP SDKは承認済みの別経路（SPEC.md §2・§9・§15）。旧HTTPへ暗黙fallbackしない
- 変換処理(内部形式 ⇄ 各 API)には必ず単体テストを書く。テストには `test/fixtures/` の実レスポンスを使う

## 絶対に守ること(セキュリティ)

- **アクセストークン・リフレッシュトークン・アカウント ID を、ログ・標準出力・ファイル・コミット・エラーメッセージに出さない**。出す必要があるときは先頭 6 文字 + `…` にマスクする
- `test/fixtures/` に保存するときは、リクエストヘッダの `Authorization` と `chatgpt-account-id` を必ず取り除く。保存前にマスク処理を通す
- `~/.claude/.credentials.json` と `~/.codex/auth.json` はXHarness・開発用スクリプトからは**読むだけ**。自前refresh、資格情報編集、期限の改変、秘密値の保存は禁止
  - 旧HTTP開発経路で承認済みの製品動作（通常desktopには接続しない）: アプリの許可操作を経た公式CLIログイン、およびSPEC.md §8の期限切れ・401時の公式CLI自動更新。書き込みは公式CLIのみ。自動更新CLIはモデル通信を伴う
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
pnpm spike:<name>  # Phase 0 の疎通確認スクリプト(Old/docs/phase0-runbook.md)
pnpm dev:fake      # Electron を --fake(通信なし)で起動
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

## コミット

- メッセージは日本語可。形式: `<領域>: <やったこと>`(例: `spike(claude): ツール呼び出しの往復を確認`)
- 秘密情報を含むファイルがステージされていないか、コミット前に `git diff --cached` で確認する
