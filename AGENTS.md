# AGENTS.md — XHarness

このリポジトリで作業するコーディングエージェント(想定: Codex / GPT-6.1 Sol)向けの指示。人間の開発者も同じルールに従う。

## プロジェクト概要

XHarness は、Claude(Pro/Max)と GPT(ChatGPT Plus/Pro)の**サブスク枠**を直接使う、Windows 向けデスクトップ(Electron)の汎用コーディングエージェント。

- 全体設計: [DESIGN.md](DESIGN.md)。**作業を始める前に、担当する節を必ず読むこと**
- UI の見本: [mockup/index.html](mockup/index.html)(ブラウザで開くだけで見られる)
- モデル一覧: [catalog/models.yaml](catalog/models.yaml)
- ロゴ・アイコン: [brand/](brand/)
- 状態: **Phase 0 のゲート完了（2026-10-01）、Phase 1 の headless 最小実装を検証済み、Phase 2 はクラウドで実装・検証済み(exe のビルドと起動確認は手元で未実施)**。Phase 2 の範囲は [docs/phase2-progress.md](docs/phase2-progress.md)、手元確認は [docs/phase2-local-check.md](docs/phase2-local-check.md)。Phase 1 の実装・確認範囲は [docs/phase1-progress.md](docs/phase1-progress.md)。Phase 0 の確認結果・未実測事項は [docs/phase0-findings.md](docs/phase0-findings.md)

## 作業の進め方

1. 実装は DESIGN.md §13 のフェーズ順に進める。前のフェーズの完了条件を満たすまで次に進まない
2. 1つの作業は小さく区切る(目安: 1コミット = 1つの目的、差分 400 行以内)
3. 設計と違うことをしたくなったら、**実装する前に**理由を書いて人間に確認する。確認が取れたら DESIGN.md も更新する
4. 調べて分かった事実(ヘッダ名、エラー形式など)は推測で埋めず、実際の通信結果を記録してから使う
5. 作業の最後に、何をして何が未完了かを短く報告する。テストが落ちている・試していないことは、そのまま書く

## 技術スタック(DESIGN.md §15-B で決定済み。勝手に変えない)

- Node.js 22 LTS / TypeScript(`strict: true`)/ pnpm
- Electron + electron-vite + electron-builder
- React + Zustand + CSS Modules
- Vitest / ESLint / Prettier
- 実行シェル: PowerShell 7(Windows)

## コードのルール

- `src/main/` の core・providers・auth・tools・workflow・hooks は **electron を import しない**(UI なしでテストできるようにするため。DESIGN.md §4)
- プロバイダごとの違い(HTTP・SSE・形式変換)は `src/main/providers/<provider>/` の中に閉じ込める。Agent Loop は `ProviderEvent` だけを見る(§6)
- 外部 API の呼び出しには Node 標準の `fetch` を使う。SDK は使わない(サブスクの OAuth で呼ぶため)
- 変換処理(内部形式 ⇄ 各 API)には必ず単体テストを書く。テストには `test/fixtures/` の実レスポンスを使う

## 絶対に守ること(セキュリティ)

- **アクセストークン・リフレッシュトークン・アカウント ID を、ログ・標準出力・ファイル・コミット・エラーメッセージに出さない**。出す必要があるときは先頭 6 文字 + `…` にマスクする
- `test/fixtures/` に保存するときは、リクエストヘッダの `Authorization` と `chatgpt-account-id` を必ず取り除く。保存前にマスク処理を通す
- `~/.claude/.credentials.json` と `~/.codex/auth.json` は**読むだけ**。Phase 0 では書き換えない
  - 例外（ユーザー承認 2026-10-01）: C5 / X7 の更新試験に限り、公式 CLI 自身による更新を許可する。XHarness のスクリプトは読み取りと変化の比較のみ行い、自前 refresh・資格情報編集・秘密値の保存は行わない
  - 例外（ユーザー承認 2026-10-01）: Phase 3 の期限切れ解消にも公式 Claude CLI による更新を許可。XHarness の資格情報読み取りのみ・自前 refresh なしの制約は同じ。
- トークンをレンダラプロセス(画面側)に渡さない
- 使用量を無駄にしない: Phase 0 の試験リクエストは最小限にし、短いプロンプトと軽いモデルを使う(手順書の指定どおり)

## コマンド

```bash
pnpm install
pnpm test          # Vitest
pnpm lint          # ESLint
pnpm typecheck     # tsc --noEmit
pnpm spike:<name>  # Phase 0 の疎通確認スクリプト(docs/phase0-runbook.md)
pnpm dev:fake      # Electron を --fake(通信なし)で起動
pnpm build         # electron-vite でビルド
pnpm package       # exe を作る(手元の Windows で実行)
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
