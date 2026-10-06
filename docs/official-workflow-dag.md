# Windows子孫プロセス管理と合成DAG

通常UI単一タスク段階の後続。実通信の再拒否は維持し、同じ呼出の再試行・別経路・別executorへの迂回はしていない。今回のアプリ内モデルはすべてmock。実providerやサブスクを使用する検証、認証変更、push/merge、配布アプリ更新は行わない。

## 子孫プロセス

`owned-process.ts`はPowerShell 7の小さなsupervisorとWindows Job Objectを使う。CreateProcessの停止状態で子を作り、Jobへ割り当てた後だけresumeする。Job handleは子に継承せず、KILL_ON_JOB_CLOSEを設定し、breakawayは許可しない。親との固有named pipe leaseを起動前に確認する。親が突然終了してもlease切断からJobを閉じ、残る子孫を停止する。PIDの保存・復元を所有証明や終了対象にしない。

公式App Serverの専用stdio、Claude SDKの`spawnClaudeCodeProcess`、独立acceptance testに接続した。nativeプロセスを実際に起動する検証はしていない。実ローカルNodeのdetached grandchildによる取消/timeout/親強制終了/正常終了後の回収と、引数/双方向stdioの検査を行う。abortはsupervisorのcloseまで待つ。不明なquery/test/commit intentは保存状態に残す。

Windows/pwshが必要。包含・起動・引数長制限に失敗したら未包含プロセスへfallbackしない。Jobが止められるのは所属プロセスの範囲で、WMI/外部サービスへの依頼、filesystemやネットワークの権限制御、既に起きた副作用の巻戻しを保証しない。[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)を参照。

## 合成DAGの実行契約

- 固定arithmetics fixtureで独立add/multiplyと依存combineを用意。テストファイル・program/argsはbackendで固定し、rendererから任意のcwd/command/権限を受けない。
- 依存先、循環、scope、model/effort/quotaを既存plan契約で検証。同一fileの作業は元の依存関係のtopological orderで直列依存を追加する。追加後の計画そのものを利用者が承認する。
- 並列は最大2。各子は管理repositoryのdetached worktree、管理領域内の固有UUID directoryだけを使う。境界のrealpath、Git common dir、HEAD、cleanを確認。fixtureのWriteは承認fileをscopedPathで検証する。
- 依存作業は前段成果が管理checkoutへ確定取込されるまで起動しない。独立waveは同じ確定HEADから開始。子の独立テスト・別providerレビュー・最大2修正には既存single-task engineを使う。
- 子の結果を直列cherry-pick。取込前intent、取込後HEAD/履歴とnode状態を保存し、保存済み取込を再度適用しない。定常衝突は管理checkoutでabortし、子成果を保持する。取込中の取消・保存境界の喪失は不明な副作用として再開を拒否する。
- 全成果の取込後、全体テストと固定base/headの全diffレビュー。混在providerは両providerの横断レビューを必須とする。指摘で全体修正・再テスト・再レビュー、全体最大2修正。
- 失敗/中断/枠不明・不足で新規起動を止め、進行waveを取消。未送信の枠停止や確定取込checkpointは利用者操作で再開できる。送信済み結果不明、未確定worktree/取込/test、変更HEAD・scope・承認、child計画不一致は停止する。
- root JSONに子のcall/usage/native metadata/テスト/review/commitとnode IDをまとめる。traceも一つのtask ID、子ごとのagent IDへ結び付ける。不明usageはnull/coverage、失敗試行も取得分を保持。模擬usageは実model比較に使わない。

## UIと再実行

fake起動の通常「公式workflow」パネルで「合成DAG（模擬・最大2並列）」を選ぶ。計画承認、取消、安全再開、nodeの状態・base/取込HEAD、全体テスト/review、JSON証拠・HTML reportを確認できる。native会話resume未対応と実provider並行未検証を表示する。

```powershell
npx tsx scripts/official-dag.ts
npx vitest run src/main/workflow/official/dag.test.ts src/main/workflow/official/owned-process.test.ts --maxWorkers=1 --testTimeout=30000
npx playwright test test/gui/official-workflow.spec.ts
```

CLIは固定fixtureだけを新しい一時管理repositoryへ作り、模擬計画を自動承認する。ユーザーのrepositoryや任意CLIを受け取る引数はない。workflow.json/report.html/traceとworktreesを残す。一般projectへコピーして実行する手順ではない。

## 一般プロジェクト適用前に必要なもの

現在のDAG公開入口は`simulated=true`かつfixture catalogに限定し、native DAGを拒否する。合成成功を実SDK/App Server成功とは扱わない。一般projectを支援する次段階には、元checkoutの変更を含めた明示scope/基準commit確認、独立管理checkoutの作成・保護、各native runtimeと実テストの強制書込み隔離、実catalog/枠の新規起動直前再確認、依存した全体修正の担当・再取込手順、差分/秘密情報制限が必要。

任意testがworktree内のコードを読み実行すること自体、別worktreeへの書込み隔離にはならない。同一ユーザーのJobはその保証を与えないため、一般project/native並行を有効にしない。custom Git filter/hook/submodule、生成binary、大きなdiff、外部サービス経由の副作用、手動の取込衝突修復・不明状態の照合解除は未対応。worktreeの自動削除・force resetもしない。

SDK/native会話のresumeは実装していない。保存した安全なphaseを新規session/threadで実行する。会話履歴、tool許可、Git/worktree、DAG状態がまとめて復元されたとは表示しない。

## 検証記録

途中の関連検証: 合成DAG10ケース合格（71.29秒）、trace集計を加えた独立/依存E2E1ケース合格（13.95秒）、通常UI single/DAG 2ケース合格（38.8秒）。Jobの3ケースは実Nodeで合格（7.97秒）。後から追加した双方向stdioは最終検証で確認する。これは実provider通信ではない。

既存テストの整理候補・時間・tierは[棚卸し](test-inventory-20261006.md)に分離した。テスト削除やproject設定変更は行っていない。最終コードの検証結果は後段へ追記する。

## 最終コードの検証（2026-10-06）

対象コードは `5d9d0ad6157416474b89016a08a90831b9f81653`。Windows、Node 24.16.0、Codex同梱PowerShell 7.6.5、repository-local pnpm。typecheck/lint/format、Electron/headless buildは合格。アプリ内実provider queryは0で、拒否済み実通信の再試行もない。

全回帰は201ファイル・1803ケースを一度実行し、1802合格・既存1件失敗（約394.2秒）。既存 `improvement-boundaries.test.ts` のsource provenance検証が、fixtureのidle待機5秒でtimeoutした。該当ファイルを分離再実行すると5件すべて合格（2.50秒）。公式workflow関連8ファイル・57ケースは全回帰内ですべて合格し、Jobの双方向stdioを含む4ケース、DAGの11ケースを確認した。

全fake GUIは23合格・既存1件timeout・2skip（約99.7秒）。既存model-candidatesがprompt有効化の10秒待機で止まり、分離再実行は1件合格（1.7秒）。新single/DAG UIは全体実行内でもそれぞれ合格（17.2/22.7秒）。2skipはportable exeとpackaged restartで、配布exeを作成・更新していないため未実行。単体/GUIとも初回失敗を取り消さず、連続全体合格とは扱わない。原因未確定の待機問題をtimeout延長や全回帰反復で隠していない。

CLIの固定mock E2Eはcompleted、3node統合、修正1回、11call。`.out/official-workflow-dag-evidence.{html,json}`へ保存済みrecordから最終reportを生成した。通常UIは `.out/official-workflow-dag-ui.png`。JSON/HTML、trace、worktreeの原本は `C:\Users\ahwri\AppData\Local\Temp\dag-RoTrvO` に保持する。全体検証ログは `.out/official-workflow-dag-final-validation.json`、`official-workflow-dag-final-vitest.json`、`official-workflow-dag-final-gui.log`。分離結果は `official-workflow-dag-improvement-rerun.log` と `official-workflow-dag-model-candidates-rerun.log`。

元の `D:\AIwork\Xharness` はHEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`・cleanのまま。push/merge、既存インストール更新、認証変更なし。最終検証後は文書・証拠記録のみを変更する。native DAGは未検証というだけでなく、一般的な強制書込み隔離が未整備のため入口で無効化している。Jobは実Nodeで検証、実SDK/App Serverのプロセス起動は未検証。この段階の完了は固定fixtureの模擬DAGである。
