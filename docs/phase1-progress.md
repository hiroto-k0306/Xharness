# Phase 1: headless 最小エージェント

2026-10-01。DESIGN.md §13 の Phase 1 の対象を実装し、ClaudeAdapter の変換テスト通過時点で途中報告した。

## 実装

- 内部形式: `src/main/core/types.ts`。provider 非依存の Message / ContentBlock / Usage / ToolSpec。
- ClaudeAdapter: `src/main/providers/claude/`。公式 CLI の OAuth ファイルを読むだけで、自前 refresh はしない。system 第1ブロックは常に識別文、第2ブロックに自前指示。Content-Type に依存しない SSE と CRLF を扱う。ツール入力は block_stop 後に1回だけ確定し、message_stop のない応答は未完了とする。
- 429: 代表枠の reset → unified reset → 得られた reset の最大値の順に Unix 秒を読み、現在時刻との差を切り上げる。reset がない実レスポンスは待ち時間不明として停止する。
- Agent Loop: `src/main/core/loop.ts`（状態機械）・`loop-steps.ts`（単独実行できる6 STEP）・`loop-types.ts`（StepOutcome と状態）。context / model / tool_use / gate / act / receipt、各 STEP の beforeStep / afterStep の入り口、毎周のレシート。権限拒否・検証エラー・中断を tool_result に戻す。読み取りは並列バッチ、書き込みは順番に実行する。
- 安全装置: 周回100回、同一ツール・引数は4回目から実行しない、連続エラー5回で停止。短い429は最大3回再試行、transport/5xx は指数バックオフで最大3回再試行。max_tokens の継続は2回まで。
- Read / Write / Edit: UTF-8。既存ファイルへの変更は Read 必須。mtime と SHA-256 を実行直前に再確認し、変更済みなら拒否する。Edit は一致箇所が1件の場合のみ置換。日時は ISO 8601。
- Bash / Grep / Glob: PowerShell 7 / ripgrep。Bash は既定120秒、最大600秒。中断・タイムアウトで Windows の taskkill による子プロセス込みの終了を試み、失敗時は親プロセスを終了する。出力は先頭・末尾を残して約30,000文字に制限する。
- REPL: `src/headless.ts`。全ツールを ask とし、`y` のみ許可。`/exit`、`/clear`、Ctrl+C の AbortSignal 接続。main 内で読んだ資格情報の秘密値を出力・tool_result からマスクし、認証ファイル名を直接読むツール呼び出しも拒否する。
- カタログ: Codex の10モデルに X5 の contextTokens 272000 を反映。Luna は low〜max。新規6モデルは enabled: false / verified: false。Ultra は保留を維持。Sonnet は下記疎通結果で verified: true。

## 確認

- Vitest 全109件成功（補正前の89件と20件の追加検証、Phase 0 の52件を含む）。ClaudeAdapter は実 fixture の変換・切断・不正ツールJSON・中断・429・秘密値を含むエラーの非露出を確認。画像と thinking/signature は合成した境界ケースでも検証。従来の effort 拒否テストは Haiku の省略を確認する新仕様へ更新し、フックの戻り値・receipt の期待値も新しい契約に揃えた。
- 型チェック、ESLint、Prettier、diff の空白チェックを実施。
- `build:headless` でビルドし、`node dist/headless.js --help` の起動を確認。
- Adapter から短い `Reply only pong.` を各1回送信。開発用は `claude-haiku-4-5`。

| モデル     | HTTP | stopReason | input / output |
| ---------- | ---- | ---------- | -------------- |
| Haiku 4.5  | 200  | end_turn   | 30 / 5         |
| Opus 5.5   | 200  | end_turn   | 44 / 4         |
| Sonnet 5.5 | 200  | end_turn   | 44 / 4         |

fixtures: `test/fixtures/claude/phase1-{haiku,opus,sonnet}-text.json`。

Haiku REPL は専用の一時ワークスペースで `Read a.txt → y で許可 → tool_result → pong` を2通信で確認。6 STEP、3レシート、正常終了を観測。`phase1-headless-read-{1,2}.json` に保存し、変換テストでも再生している。失敗した最初の REPL 起動は Windows の preload パス形式が原因で、通信前に終了した。

system・tools・直近メッセージ末尾の cache_control は [公式仕様](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) に沿って ephemeral を付与（thinking には直接付けない）。Haiku で追加1通信が HTTP 200 / pong。短い入力なので cacheRead/cacheWrite はともに0で、キャッシュヒット自体は未実測。`phase1-cache-haiku-text.json` に保存。Opus / Sonnet の試験はキャッシュ印追加前の各1回のみ。Phase 1 の実通信は合計6件で、Phase 0 の永続予約を再利用し Claude の予約は19/20。

## 次フェーズ・未確認

- Phase 1 は UI なしの最小実装。モデルは固定選択。fallback は Phase 3、圧縮・セッション保存・永続レシート・権限ルールは Phase 4、設定でのフック実行は Phase 5。現在のフックはプログラム内の呼び出し口のみ。
- Opus/Sonnet 5.5 は effort high を既定として明示し、low/medium/high/xhigh/max を選べる。Haiku は effort を送らない。実通信は high のみ。キャッシュ印の受理は Haiku で確認したが、ヒットは未実測。
- 実 OAuth 更新・期限切れ試験は引き続き未実測。期限切れでは公式 CLI での更新を案内する。
- 中断は AbortSignal の単体試験で検証。実キーボード Ctrl+C、タイムアウト時の任意の孫プロセス終了、REPL からの Write/Edit/Bash は未実測（各ツール自体はローカル試験済み）。
- ファイル変更の再確認と書き込みの間は、OS の排他的ロックを保持していない。別プロセスとの完全な排他制御は行っていない。
- Phase 2 には着手していない。

## Phase 2 前の補正（2026-10-01）

ユーザー指定の1〜3（effort・catalog・thinking と追記履歴）を先に終え、受理確認後に途中報告し、4〜5（HookResult・StepOutcome）へ進めた。

- Opus 5.5 / Sonnet 5.5 に `output_config.effort: high`、thinking 省略、`tool_choice: auto` を各1回のみ送信。両方 HTTP 200 / end_turn / pong、input 400・output 4、cacheRead/cacheWrite 0。`phase1-{opus,sonnet}-effort-high.json` に秘密値を除去して保存。この補正は新たな2件限定の永続予約を使用し、元の予約19/20は変更していない。追加送信は2/2、Phase 1 全体の実通信は合計8件。
- カタログ: Opus/Sonnet は5段階・defaultEffort high、Haiku は efforts / defaultEffort なし。[公式 effort 仕様](https://platform.claude.com/docs/en/build-with-claude/effort) と今回の high の実測を区別して記録。
- 会話履歴はコピーして追記する。署名を含む thinking の既存ブロックは修正せず返送し、キャッシュ印も thinking 自体には付けない。画像・思考の合成境界ケースに加え、次のモデル入力で履歴の先頭が不変であることを検証。
- HookResult は continue / inject / block / stop。履歴を凍結したスナップショットで渡し、inject は tool_result または新しい user メッセージへ追記する。block は before のみ有効。stop・例外時もツール結果と毎周のレシートを保存する。フックの結果もレシートに追加する。
- STEP は StepOutcome を返す個別ユニットとしてテスト可能。model の retry はドライバが待って同じ STEP を再実行する。next / retry / fallback / stop の dispatch、権限・中断・繰り返し・max_tokens・周回上限の既存挙動を検証。fallback の型・遷移だけを用意し、モデル切替自体は引き続き Phase 3。
- 型チェック、lint、整形、headless ビルドを確認。REPL の Read 許可から最終回答まで保存 fixture でオフライン再生して成功（新たな通信なし）。

## 起動

```powershell
pnpm build:headless
node dist/headless.js --cwd D:\path\to\project
# または pnpm headless
```

PowerShell 7 と ripgrep が PATH 上に必要。モデル既定は Haiku。`--model claude-opus-5-5` または `claude-sonnet-5-5` も選べる。API キーは不要。
