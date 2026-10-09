> **旧版・履歴資料（2026-10-09整理）**：現行仕様として使用しない。記載されたリビジョン・環境での記録です。現行仕様は [SPEC.md](../../SPEC.md)、移動対応は [Old索引](../README.md) を参照。

# Phase 6 進捗（2026-10-02）

ブランチ: `codex/phase6`。起点は Phase 5 を統合した main の `98f4b8a`。

## 前段の認証確認

追加許可を受け、公式 Claude CLI で Haiku の最小試行を1回実施した。資格情報の更新と期限切れ解消、短い応答を確認した。その後 XHarness の explorer 子エージェントから Haiku に2回送信し、Read を1回使って `local read check` を返すことを確認した（両送信 HTTP 200）。XHarness による自前 refresh・資格情報編集は行っていない。秘密値は出力・保存していない。

この追加確認は Claude 3枠（CLI 1試行 + 直接通信2回）、Codex 0回。既存の予算台帳は Claude 8/8枠、Codex 3/12枠。CLI 内部の HTTP 回数は取得しておらず、試行1回として計上している。Phase 6 の再生開発では実 API に送信していない。

## 最初の実装単位: レシート再生

- `DESIGN.md` §23 に、通信なしの初回再生と権限比較の仕様を記載した。
- receipts の「再生」で、開いた時点の追記順スナップショットを前後移動・500msごとの自動再生で表示する。ISO 8601 の時刻、親・子の識別、入力・出力を表示する。Esc は再生だけを閉じる。
- headless の `--replay <sessionId>` は保存記録を JSON にして終了する。`--replay-parent <parentId>` で子の記録も読める。Provider・セッション・ツールは初期化しない。
- `--replay-mode default|acceptEdits|plan --cwd <path>` は現在の権限ルールだけを比較する。Bash・Write・フックは実行せず、ask は ask のまま。保存された判断が無いときは一致・不一致を判定しない。後続の録画応答を変更後の予測として扱わない。
- 件数・容量の上限、ID の検証、秘密フィールドの再マスク、不正行の除外と件数表示を追加した。HTML は文字として表示する。
- 実際の Haiku 子エージェントの3レシートを、パスを正規化し秘密値・認証ヘッダが無いことを確認して `test/fixtures/replay/receipts/haiku-read.jsonl` に保存した。元の Read レシートには判断が保存されていないため、補っていない。

## 検証

- Vitest: **57ファイル・463件、全件成功、スキップ0**。Phase 5 の448件から15件追加。Windows PowerShell 依存のテストも通った。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm build:headless`: 成功。
- 実録再生、親・子ファイル、CRLF、不正行、逆順時刻・重複番号、サイズ上限、秘密マスク、再生中の追記との独立性、自動再生、Esc の中断防止をテストした。
- headless を別プロセスで実行し、保存記録が変更されず、セッションや作業状態ファイルが作られず、記録された Write が実行されないことを確認した。危険なオプションの組み合わせは REPL に入る前に拒否する。
- ソース・fixture・main bundle をローカル資格情報とメモリ内で照合し、一致0件。禁止された fixture ヘッダ0件。
- Windows のネイティブ画面確認: ビルドした Electron を専用の fake 保存領域で起動し、既存の workflow の17レシートを再生した。親・worker の識別と ISO 時刻、左右キーで前後移動、自動再生、17/17で停止し次へ・自動再生が無効になること、Esc で再生だけが閉じることを確認した。画面の記録数は17件のまま。実行中セッションへの Esc の非伝播は renderer テストで確認した。
- ビルド済み `dist/headless.js --fake --replay haiku-read` でも、実録3件・除外0件・Read の表示を確認した。
- 初回のテストで、実録の判断が無いケースを一致と期待していた1件が落ちた。期待を「不明」に修正した後、全件成功。型検査の重複 import も修正済み。

## 未実施・後続の単位

Phase 6 全体の完了ではない。MCP クライアント、自動アップデート、新しいモデルでの有料再実行・比較は未実装で、接続・配布仕様も未確定。worker 並列数拡張・workflow 自動再開・worktree の片付け UI は引き続き後続。Phase 5 の残る画面操作・実プロジェクトでのレビュー品質確認は `phase5-local-result.md` に残している。

今回の変更は `codex/phase6` ブランチで、認証確認の記録・再生基盤・権限比較・headless・画面・進捗記録の目的別に6コミットし、プッシュ済み。2026-10-02 にユーザーが、この初回実装単位の main へのマージを承認した。Phase 6 全体の完了は意味しない。

## レビュー対応(2026-10-02、クラウド)

- **保守性**: `src/main/session/controller.ts`(1627 行)を、共有の型(`context.ts`)・1ターンの実行(`turn.ts`)・イベント変換(`turn-events.ts`)・workflow の組み立て(`workflow-factory.ts`)・権限確認(`permission-gate.ts`)・worktree 操作(`worktree-commands.ts`)・設定コマンド(`settings-commands.ts`)に分けた。controller は 576 行の窓口になり、公開 API と挙動は変えていない(分割直後に既存 457 件が全件成功)。
- **権限のすり抜け**: PowerShell の部分式 `( )`・スクリプトブロック・`rg --pre`・`git -c` などで、plan モードや `git *` の許可から任意のコマンドが動いた問題を修正。コマンドの解析を `core/shell-command.ts` に分け、単純でないコマンドはルールで許可しない。「常に許可」はサブコマンド単位(`git status *`)に狭めた。WebFetch はドメイン単位。
- **ワークスペースの信頼**: Claude Code の仕様に合わせ、プロジェクト設定の allow ルールと acceptEdits は信頼後だけ適用する。「常に許可」はリポジトリの外(ユーザー側)へワークスペース単位で保存する。
- **秘密情報**: memoryFiles はホームと作業フォルダの中だけを読む。作業フォルダ外の Read/Grep/Glob は確認する。秘密ファイルの一覧を広げ、保護パスへの書き込みは常に確認する(`core/sensitive-paths.ts`)。
- Prettier の不合格(4 ファイル)を解消し、録画 fixtures を整形対象から外した。
- 検証: Vitest 521 件成功・6 件スキップ(Linux に pwsh が無いため)。型チェック・lint・Prettier・`electron-vite build` 成功。追加した回帰テストは、修正を外すと失敗することを確認した。
- 手元で実施が必要: Windows でのテスト全件(PowerShell 依存を含む)、信頼の確認が画面に出ること、既存の `~/.xharness/config.yaml` に保存済みの広い Bash 許可(`git *` など)は自動では狭めないため、必要なら手で見直すこと。
