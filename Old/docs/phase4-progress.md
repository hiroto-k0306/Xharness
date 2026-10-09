> **旧版・履歴資料（2026-10-09整理）**：現行仕様として使用しない。記載されたリビジョン・環境での記録です。現行仕様は [SPEC.md](../../SPEC.md)、移動対応は [Old索引](../README.md) を参照。

# Phase 4 実装・確認記録

2026-10-02、手元 Windows / PowerShell 7。Node 22.23.3、pnpm 10.34.6。
Phase 3 の未コミット差分を保持して `phase3` ブランチで実装。main へのマージ、コミット、push はしていない。

## 実装した範囲

- Permission Gate (§9): グローバルとプロジェクトのルールを読み、deny を優先。default / acceptEdits / plan、今回・セッション中・常時許可・拒否。常時許可はグローバル設定へ原子的に保存。モードはセッション単位で保存し、入力欄、Shift+Tab、`/mode` から変更してレシートに記録する。
- 作業フォルダ外の書き込みは canonical path で判定し、junction 越しでも ask。秘密ファイルも ask。資格情報ファイルは既存の FileAccess で利用不可。危険な Bash、複合コマンド、書き込みの PowerShell コマンドは広い allow でも ask。plan の Bash は単純な読み取りコマンドの許可リストで判定する。
- 設定・メモリ (§12): `main` / `aliases` / `fallback` / `web` はプロジェクトの指定キーを優先してマージ。新規セッションは CLI 指定を優先し、保存済みセッションのモデルを再開時に上書きしない。permissions のルールは両設定から集め、context はプロジェクト指定を優先。メモリはグローバルとプロジェクトの指定ファイルを読む。scratch はグローバルのみ。資格情報・秘密ファイルをメモリに組み込まない。
- Context (§19 STEP 1): UTF-8 JSON の大きさからトークンを推定し、既定 80% で古い履歴を抽出式に圧縮する。追加のモデル要求は行わない。直近2回のユーザー発言以降とツールの組は残し、残した thinking / reasoning は変更しない。元の履歴 JSONL は追記のみ。送信用の短い履歴と `context/<id>.json` のチェックポイントを分け、`/compact` と自動圧縮を用意する。system・ツール定義・出力の予約分も見積もり、圧縮後に上限を超えると停止する。
- 保存・再開 (§18.4): 会話、モデル、effort、モード、cwd、worktree 情報、レシート、圧縮位置を保存。UI から再開でき、Electron / headless とも `--resume <id>` に対応。headless の `/clear` は元の履歴を消さず新規セッションを作る。
- 可視化 (§16): Hero、6 STEP の LoopFlow、Receipts の一覧と入力・出力詳細、UsagePopover。使用量は Claude / Codex のヘッダから正規化し、不明と 0% を区別する。80% / 95% の色、95%超の一度だけのトースト、reset までの時間と fallback を表示。Ctrl+U、Ctrl+H、Esc、外側クリック。狭い画面は Transcript / LoopFlow のタブ切替。Sidebar は 200〜400px に変更・保存できる。複数ツールの act は何件目かを表示する。
- Repository / worktree (§18.2–4): システムの git で clone / fetch、ブランチ、shallow、保存先、進捗、中断。既存 clone のブランチ切替は未コミット変更があると止める。Fake モードではリポジトリのネットワーク操作を拒否する。隔離は専用の `worktrees/<workspace>/<session>` とブランチを作る。同一ワークスペースの同時書き込みを止め、worktree を使用するセッションは別に実行できる。
- worktree は終了時にも既定で残す。マージ・削除は明示操作。未コミット変更のマージは拒否し、削除は確認を要求する。削除前には管理ディレクトリ内の実パス、共通 Git ディレクトリ、ブランチを検証する。消えた worktree は保存済みブランチから確認後に復元できる。処理中は対象ワークスペースへの実行・重複処理を止める。

## コンテキスト上限

ユーザーの「1M」の回答を反映し、[Claude 公式モデル一覧](https://platform.claude.com/docs/en/models/overview) と照合した。Opus 5.5 / Sonnet 5.5 は 1,000,000、Haiku 4.5 は 200,000 として catalog、ClaudeAdapter、FakeProvider に反映。Codex は Phase 0 で確認済みの 272,000。

サブスク OAuth で上限まで入力する実測はしていない。見積もりは tokenizer の厳密値ではなく、圧縮もモデルによる意味的な要約ではない。省略した詳細は元の履歴に残るが、送信時の細部保持の品質は実 API の長い会話では未評価。

## 検証

- `pnpm test`: **41ファイル、361件、全件成功、skip なし**。Phase 3 の321件から40件追加。PowerShell 依存の既存2件も含む。
- 権限: モード、deny 優先、常時保存、セッション単位のモード、junction、秘密ファイル、危険コマンド、設定のマージと競合保存。
- 圧縮: 閾値、元の履歴の不変性、ツールの組、opaque reasoning の保持、overflow、フックの追加情報、チェックポイントからの再開。Controller と headless の実プロセスでも履歴保存・圧縮・再開を確認。
- Git: 一時リポジトリで実際に clone / fetch / checkout / worktree / commit / merge / remove / restore を実行。clone の URL はテスト内でローカルの一時リポジトリへ置換し、外部へ通信しない。URL の拒否、未コミット保護、削除の確認、元のファイルと残すブランチ、中断も確認。
- UI の部品テスト: quota 不明・0%・閾値、reset / fallback、Esc、レシートの HTML 非実行、権限待ちの枠、repository と隔離オプションの IPC。
- 手元の Electron を `--fake` と専用 `.out/phase4-ui` で起動。`ping → pong`、使用量 83% と未取得表示、ポップオーバーの Esc、`--resume` で履歴とレシートの再表示、`slow` で model の光る枠、レシートの入力全文を目視確認。確認中に見つかった入力欄の古い ask 表示をモード選択へ修正した。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm build:headless`: 成功。
- 現在のローカル資格情報をメモリ内の検査値として、tracked / non-ignored untracked / main bundle / 検索報告の227ファイルを照合。一致0、検索録画の禁止ヘッダ0。秘密値は出力・保存していない。
- `git diff --check`: 成功。

## 通信と未実施

**Phase 4 の実 API 送信は Claude 0回 / Codex 0回。外部リポジトリへの clone / fetch も0回。** Phase 3 の通信回数は `Old/docs/phase3-progress.md` に保持し、今回追加していない。

- 実 API の長い会話での圧縮品質、OAuth でのコンテキスト最大入力、実429の画面表示は未実施。録画・合成イベントで検証した。
- 外部 Git サービスの実認証、clone のネットワーク中断、実競合のマージ UI は未実施。一時 Git リポジトリと部品テストで確認した。
- Phase 4 の portable exe の再作成・別フォルダ起動、狭い実ウィンドウでの全操作、今回の権限 y/a/n の手元キー操作は未実施。権限の動作は自動テストで確認した。
- §18.5 の scratch からワークスペースへの移動・削除 UI は未実装。今回の §13 Phase 4 の repository / worktree と保存・再開の範囲には含めていない。
- サブエージェント、AgentsPanel、workflow / PhaseBar、ModelPicker は Phase 5。意味的な要約を行う追加モデル呼び出しは入れていない。
- Phase 3 の元の `Old/docs/design-websearch.md` は引き続き別PCにあり、原文との照合は未完了。§22 はユーザー承認済みの暫定仕様のまま。
- 差分は未コミット。コミット時には Phase 3 と4を目的別に分割し、ステージ済み差分の秘密情報を再検査する。
