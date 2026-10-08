# 通常workflowの結果受け渡し拒否の修正（2026-10-08）

対象は `810aac30f975db34c372b789fd11a98772531ee5`（PR #20のmain）から作成した `fix/official-result-handoff`。開始時の作業ツリーはclean。現行仕様は SPEC.md §10。実通信・認証操作・アプリ起動・既存homeへの書き込みは行わない。

## 原因

受け渡しは `SessionStore.evaluationTask` の確定状態と旧Agent Loopの完了traceを必須としていた。通常入力の公式Claude SDK／Codex App Server経路は `official-workflows/<id>/workflow.json`、OfficialWorkflow receipt、会話の最終回答を保存するが、旧評価task/traceを作らない。この保存形式の不一致により、正常終了した通常workflowも「確定済みの完了タスク」がないとして拒否される。SDK・モデルの拒否や利用枠の問題ではない。

## 修正

- 保存形式に応じて根拠を照合する。公式接続はreceipt ID、workflow ID/session ID、開始・終了日時、completed/complete、呼出終了状態、最新の利用者入力と公開最終回答の一致が必要。質問回答は対象にできるが、作業分類だけの対象確認待ちは拒否する。
- 作業は同じcwd、承認済み計画digest、最終HEADの独立テスト成功・レビュー（blocking指摘なし）も確認する。質問の隔離cwdを作業cwdと誤認しない。
- 新しいassistant履歴にworkflow ID・状態・対象確認待ちを記録する。既存履歴を編集せず、metadataがない旧公式履歴もreceipt・workflow・本文が一致する場合に確認する。表示用summary生成を共通化し、生成した回答を後から推測しない。
- 欠落・壊れた保存・リンク先への差し替え・失敗・取消・実行中・未確定・巻き戻しは拒否。公式根拠が不正なら旧traceへ戻して許可しない。プレビューと明示送信の間に根拠や本文が変われば失効する。
- 既存のproject境界、権限、session lease、60秒確認票、atomic台帳、二重配送防止を維持する。受信だけでモデルを実行せず、宛先会話・権限・認証を変更しない。

## 検証

Windows、Node 24.16.0（`C:/Program Files/nodejs/node.exe`）で、関連7ファイルの重複を除いた **102テスト成功**。handoffs-official 18、handoffs、handoffs-cli、official-session、official/serviceで88件。追加のstorage-consistency、premises-compactとhandoffs-officialを合わせ32件（18件は再実行）。全回帰は未実行。

公式経路は偽実行器と一時home、旧経路はFakeProvider、CLIはmockを使用。質問・作業の正常配送、旧公式履歴、再起動後の受信、宛先不変、二重送信、保存変更、対象確認待ち、失敗、取消、実行中、期限/取消を含む旧経路の境界、壊れた記録・junction、権限・保存復旧拒否を確認した。模擬workflowのテスト証跡を、実際のAI実装や独立テスト成功と扱わない。

型チェック・lint・通常build・headless build成功。最初の追加テストではfixtureの不足とlint prefer-constを検出し修正した。検証用pnpm wrapperのNodeは22.23.3。シェルはCodex runtime同梱PowerShell 7.6.5（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。この修正はPowerShell子プロセスの起動に関わらず、ユーザーのStore版pwsh成功を主張しない。

Node 22.23.3でも追加18テスト成功。全体の整形チェックと `git diff --check` 成功。Node 24の102件と重複するため総件数には加算しない。

## 未確認・利用時の注意

今回のコードで実アプリの画面操作と実通信は未実施。既存配布物はこの修正を含まない。新しい配布物への反映後、同じprojectの完了した質問または作業から「結果の受け渡し」→宛先選択→プレビュー→内容確認→明示送信→受信一覧を手元で確認する必要がある。保存記録が欠落した過去の結果は救済せず、既存履歴を捏造・移植しない。作業の最終回答は現行の公開summaryであり、SDK内部応答や思考を新たに本文へ取り込まない。

過去の実通信報告・紹介資料にある受け渡し拒否は当時の配布版の事実として残す。本修正のオフライン成功に置き換えない。push・merge・インストール更新は行わない。
