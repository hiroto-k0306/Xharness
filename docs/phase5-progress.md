# Phase 5 進捗

更新: 2026-10-02。ユーザーの「5まで実施して」に従い、Task / workflow / worker 統合、専用 UI、汎用 STEP シェルフックまで実装した。コミット・プッシュ先は `codex/phase5-runtime`。main にはマージしていない。

## ブランチと開始点

- Phase 3・4 の差分を目的別の21コミットに分割し、`phase3` の `7bad8d1` まで `origin/phase3` にプッシュした。
- その地点から `codex/phase5` を作成した。その後、ユーザーが両ブランチをマージしたことを確認し、`origin/main` の `43d8663` から今回の `codex/phase5-runtime` を作成した。今回の変更は main にマージしていない。
- Phase 3・4 の未実施事項はそれぞれの進捗文書に残している。今回の開始は、それらの確認を済ませたという意味ではない。

## 最初の実装: 計画検証と直列スケジューラ

DESIGN.md §13・§21.2〜21.4 に従い、Electron と通信に依存しない基盤を追加した。

- `PlanItem` と、未信頼の SubmitPlan 引数を受け取る `validatePlan`。
- 項目形式、ID 重複、存在しない依存先、自己・間接循環を拒否する。
- enabled なカタログモデル・設定した aliases・対応 effort を検証する。Ultra は受け付けない。
- Haiku の担当 effort は割当メタデータとして扱う。既存 Adapter と同様に API へ effort を送らない。
- ワークスペースから出る相対パス、絶対パス、Windows の代替ストリーム指定を拒否する。
- Windows の大小文字・区切り文字を正規化し、依存関係のないファイル重複は直列化を要求する。glob の交差が不確かな場合は保守的に重複と判定する。
- 既知の5時間枠使用率が90%を超えた割当は、別プロバイダを提案する警告にする。未知の使用量を消費済みとして扱わない。
- `SerialScheduler` は同時に1項目だけ起動し、依存先の統合まで待つ。main の割当を保持する。統合失敗時は起動を止め、明示的な再試行を受け付ける。
- 入力計画と返すスナップショットを複製し、呼出側の変更による状態破壊を防ぐ。

## 検証

- 初期基盤: Vitest **43ファイル・389件**。今回の全体検証結果は下の追記に記載する。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm build:headless`: 成功。
- 実 API 送信: Claude **0回**、Codex **0回**。新しい通信や資格情報更新は行っていない。

## 1〜3 の実装

> 以下は2026-10-02時点の実装記録。現在は must / should の両方が解消するまで修正し、2026-10-04にレビュー上限の既定を初回を含む合計5回へ変更した。詳細は [review-limit-progress.md](review-limit-progress.md)。

- **Task / 子セッション**: explorer / reviewer の定義をグローバル・プロジェクト設定から読み、モデル・effort をカタログで確認する。子には prompt とプロジェクト指示を渡し、親の履歴は渡さない。子は Task・Write・Edit を使えず、reviewer の Bash はテストコマンドに限定する。最終テキストだけを親の tool_result に返す。履歴とレシートは `agents/<parentId>/` に独立して保存し、親の中断・終了は子の通信・権限待ちも終了させる。
- **計画とレビュー**: auto / always / off、SubmitPlan・SkipPlan・UpdatePlan・RequestReview を Agent Loop に接続。計画中の書き込みを禁止する。ask の計画承認は既存の権限確認欄に全文を出し、広い allow ルールでも自動承認しない。却下すると止め、次の入力で修正できる。全項目の統合と実際の変更が揃うまでレビューしない。main の end_turn だけでは実装完了にならない。
- **レビューの終了条件**: JSON の ReviewFinding を厳密に読む。must が無ければ終了し、should / nit も通知する。must があれば implement に戻し、既定2回で残る場合は止めてユーザー判断を待つ。不正なレビュー出力や通信失敗は完了扱いしない。Claude の実装は Codex、Codex の実装は Sonnet、両方があれば2件を並行してレビューする。レビュー失敗・中断時はもう一方も止め、権限確認は待ち行列で1件ずつ扱う。
- **worker の実行と統合**: 同時実行1件。main の項目は親のループで実行する。worker は `xh/<session>-w<n>` の専用 worktree と子セッションで動き、ReportDone を受けてから実際の変更を検査・コミット・統合する。資格情報ファイル・秘密値を含む差分は自動コミットしない。Git フックは自動コミット・マージ時に実行しない。統合に失敗した worktree とブランチは残す。main が競合やテスト失敗を解消するまで後続を止め、再試行や修正計画の再提出を受け付ける。
- **フォルダモード**: `.git` が無いワークスペースや `workflow.worktrees: false` は、同じフォルダで直列実行する。実際の headless デモで、Git 内の普通のサブフォルダを親のリポジトリとして扱う不具合を発見し、既存のワークスペース分類に合わせて修正・テストした。レビューに親リポジトリの無関係な変更を含めない。
- **wave テスト**: 設定した `after:receipt`・`when.phases: [implement]` のコマンドを統合後に実行する。tools / agents / pathGlob の条件があるフック、または複数段階を指定したフックは汎用 STEP ディスパッチャで扱う。終了コードが非0なら main に返して後続を止める。設定無しは「テストフック未設定」であり、テスト成功とは扱わない。
- SessionController と headless の両方へ接続。workflow / 子の STEP / agent 状態イベントは renderer の状態へ届く。

## 4〜5 の実装

- **AgentsPanel**: main・worker・reviewer を選ぶと、そのエージェントの StepTabs / LoopFlow / Transcript が切り替わる。既定は最新の STEP に自動追従。子の会話を親の会話と混ぜず、完了後は保存用履歴からツールカードも表示する。状態・権限確認待ち・worktree ブランチ・未起動項目を表示し、Sidebar に実行中の子の数を出す。
- **PhaseBar**: plan → implement → review、項目の統合数とレビュー回数、担当モデルを表示する。実行中の枠は既存の回転表現を使う。分類・質問だけのときは非表示。クリックで親の Transcript の段階マーカーへ移動する。
- **計画承認**: y 承認 / e 修正指示 / n 却下。各項目の main / worker、enabled モデル、対応 effort を編集できる。IPC ではサイズと形式、main では計画・依存・ファイル・モデル・effort を再検証し、不正な編集では承認待ちを解消しない。修正指示は承認を拒否してから入力欄へ戻す。
- **ModelPicker**: 右下のボタン / Ctrl+M。カタログの enabled モデル・effort から生成し、Haiku は effort 欄を出さない。apply はそのセッションだけ、既定にするはグローバル設定だけを変更し、既存の他セッションを変更しない。既定は一時ファイルから置換して保存する。次の STEP 1 から反映する既存ルートを使う。
- **手動段階**: `/phase plan|implement|review` と `/review`、PhaseBar の操作欄。実行中は STEP 6 を閉じた時点で変更する。レビューは統合済み項目と実差分を要求し、ユーザー操作でも完了状態を捏造しない。待機中の `/review` は main を呼ばず reviewer だけを実行する。
- **STEP フック**: 全6 STEP の before / after、tools / agents / phases / pathGlob、PowerShell コマンド・timeoutSec、onFailure: inject / stop、before の onMatch: block を接続した。凍結した履歴・ツール引数を使い、thinking を変更しない。`{{files}}` は単一引用符の PowerShell リテラルとして展開し、ファイル名によるコマンド実行を防ぐ。
- **承認とレシート**: プロジェクト由来のフック一覧は初回に承認を求め、STEP / wave / 子の実行で共有する。拒否時は実行しない。実行結果・失敗・中断を provider:hook のレシートとして表示し、子のものは子の履歴にも保存する。注入を使っても計画承認・レビュー完了の判定を迂回しない。

## 今回の検証

- Vitest: **52ファイル・444件、全件成功、スキップなし**。初期基盤の389件から55件追加。既存の Windows PowerShell 依存2件と、新しいフックの実行・引数展開・タイムアウト・中断試験も成功。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm build:headless` と `git diff --check`: 成功。Electron と headless のビルドは警告無し。
- ソース・fixture・main bundle を含む255ファイルを、ローカル資格情報をメモリ内の検査値として照合。一致0件、禁止された fixture ヘッダ0件。秘密値は出力・保存していない。
- 一時 Git リポジトリで2 worker の実装・コミット・マージ・各 wave のテストと依存順序を確認。実際の競合を作り、競合状態と worker ブランチが残ることも確認した。
- Task の親履歴非継承、無効モデル、worker の Task 起動拒否、計画中の書き込み禁止、レビューの必須指摘・往復上限・不正形式・変更無しを検証。
- 親の abort / close / shutdown 中の子の権限待ち、2 reviewer の待ち行列と中断、allow ルールを使った計画承認の迂回防止を検証。
- renderer では実際の App の選択操作から StepTabs / LoopFlow / Transcript の切替を確認。計画の y/e/n、担当の編集、モデル選択と既定保存の分離、PhaseBar の非表示・ジャンプ・進捗、子の会話分離をテストした。main 側では編集計画の拒否とモデル反映、手動レビュー、実行中の段階変更の待機、子フックの独立保存を確認した。
- プロジェクトのフック一覧が300文字を超えても末尾まで提示され、同じ設定への承認が次のターンにも再利用されることを、Windows の実コマンドで確認した。設定が変わると承認を取り直す。
- 実際の Windows headless REPL を `--fake` と専用 `.out/phase5-headless-home` / `.out/phase5-headless-demo` で起動。`task-demo` の explorer 往復と、`workflow-demo` の計画 y 承認 → worker の Write y 承認 → Sonnet reviewer → workflow_complete → `/exit` を確認した。デモは合成応答で、通信しない。
- 4〜5 の追加後も専用 `.out/phase5-final-home` / `.out/phase5-final-folder` で headless を起動。main の before:model フックを設定し、workflow-demo の完了後に `/review` で reviewer だけを再実行し、`/phase plan` → `/exit` を確認した。
- **実 API 送信は Claude 0回 / Codex 0回**。資格情報更新や外部 Git リポジトリでの worker 実行は行っていない。

## 次の作業・未実施

- worker の並列数拡張、保存した workflow 状態からの自動再開、worker worktree の片付け UI。作業物は削除せず残す。
- 2026-10-02 の追加手元確認は [phase5-local-result.md](phase5-local-result.md) に記録。portable の再作成・別フォルダ起動、fake workflow / 子の会話 / 権限待ち終了 / プロジェクトフックを確認した。Codex Luna reviewer に1回送信し、明白な不具合の検出と子の完了を確認。追加許可後、公式 Claude CLI の認証更新と Haiku 子エージェントの Read 往復も成功した。実プロジェクトのレビュー品質・残る画面操作は未評価。
- Bash は worker の cwd で実行し、必ず権限確認する。OS のファイルシステム sandbox は追加していない。Write / Edit は canonical path を確認して作業フォルダ外を拒否し、計画の files の外は ask にする。
