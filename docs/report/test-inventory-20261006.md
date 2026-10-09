> 過去の記録：移動元 `docs/test-inventory-20261006.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# テスト棚卸しと実行tier案

対象: `e3090b2` の既存全回帰ログ。199ファイル実行・1787ケース、249.30秒。新DAGの開発検証とは分け、棚卸しのための追加全回帰は実行していない。以下は整理案で、テスト削除や設定変更は行っていない。

## 現役経路

`src/main/session/turn.ts` はconnection選択後、通常のlegacy経路でRouter/direct HTTPと旧WorkflowRuntimeを引き続き呼ぶ。新公式SDK/App Server workflowは独立入口であり、旧方式を置換・廃止していない。`phase5.test.ts` という歴史的名前も、現在のproject hook承認、保存や通常会話を検証する。名前だけで廃止と判断しない。

旧adapterのwire変換/SSE/usageと新SDK/App Serverのnative usage/session/permissionは別契約。共通化候補は集計・品質判定の表形式ケースで、provider raw契約の検査は残す。spikeのfixture再生は過去のwire知識であり、現在の実provider成功とは呼ばない。

## 実際の重複

Vitestのnode projectは`src/**/*.test.ts`、renderer projectもrenderer内の`.test.ts`を含む。このため次が両環境で実行される。

| ファイル                               | 各環境のケース数 | 推奨                                                                        |
| -------------------------------------- | ---------------: | --------------------------------------------------------------------------- |
| `src/renderer/workflow-bridge.test.ts` |                1 | jsdom専用。テスト名もjsdomでmain bridgeを扱う保証                           |
| `src/renderer/state/groups.test.ts`    |                6 | 純粋関数をNodeで一度。DOM表示の確認はcomponent/E2Eで担当                    |
| `src/renderer/state/store.test.ts`     |               11 | reducer/event契約をNodeで一度。古いpermissionイベントによる上書き拒否は維持 |

余分な実行は計18ケース。ケース時間の重複分は約0.06秒、両環境合計約0.12秒で、全体の大幅な時短にはならない。project起動の追加コストはこのログから分離できない。環境差を意図した保証を確認してからinclude/excludeを整理する。

## 実行時間上位と分離候補

| ファイル                               |            実測 | 守る故障モード・整理候補                                                                                                                 |
| -------------------------------------- | --------------: | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `main/workflow/runtime.test.ts`        | 25.9秒/72ケース | 計画、承認、worker成果取込、必須レビュー、停止。純粋な遷移/候補検証をport unitへ分離し、実Git・ファイル・再開の代表integrationを残す     |
| `workflow/official/runtime.test.ts`    | 18.9秒/16ケース | provider横断レビュー、独立テスト、失敗試行usage、安全checkpoint。契約ケースと実プロセスE2Eを分ける。自己申告とテスト結果の区別は削らない |
| `main/tools/background-shells.test.ts` | 10.0秒/16ケース | 所有、取消、timeout、出力制限、並行停止。実プロセスの子孫回収はintegration、純粋な状態整形はunit                                         |
| `src/headless.test.ts`                 |   7.7秒/6ケース | UIなし起動、保存、IPCとの整合。実起動は節目。単なるdata変換はunitへ移す候補                                                              |
| `main/mcp/mcp.test.ts`                 |  7.3秒/16ケース | 接続・失敗・取消・tool権限。mock server起動を要するものはintegration                                                                     |
| `renderer/App.test.tsx`                |  6.0秒/13ケース | renderer権限・操作。文言、非本質的なDOM順序、event数だけの期待は意味のある操作/状態へ置換候補                                            |

分類は読取と既存ログによる。削除可能数や時短効果はまだ測定していない。mutableなGit repositoryをケース間共有して速度を稼ぐ変更は、相互汚染と並行故障を隠すため推奨しない。

## 結合とflakyの候補

- `spike/*/{text,tool,models,effort,replay}.test.ts` とproduction adapterが同じ記録fixtureを読む。spikeの探索用詳細を常時tierから外し、productionのwire契約・usage・未知field・取消を常時維持する候補。fixture年代のmodel名は歴史資料として保持し、最新model availabilityを保証する検査には使わない。
- request数/順序の厳密期待は、無許可通信・二重実行・上限を守る場合に必要。単なる内部呼出順の期待とは区別し、後者のみ外部結果へ置き換える。snapshotを一括削除しない。
- 既存`test/gui/improvements.spec.ts`は初回22合格/2skip/1timeout、単独再実行1合格、続く全体23合格/2skip。promptがenabledになる時点と新評価session/比較panelの安定時点の競合が調査候補。timeout延長・自動retryで隠さず、保存済み評価と対象sessionを確認する待機へ修正する案。今回コード変更なし。

## 条件付き検証

- Windows限定: CLI login/refresh、protected SIWC storage、local links、reviewer command、shell hooks、project hooks、process環境。Linux合格はこれらの代わりにならない。
- `pwsh`/Store版shell/ripgrepの存在条件: shell環境、background shell、PowerShell起動、rg実行。それぞれshell実体・encoding/window表示・取消・探索経路を守る。skipの理由と実体のversionを結果へ残す。
- GUI portableは`XHARNESS_TEST_PORTABLE`、packaged restartは`XHARNESS_TEST_EXECUTABLE`が必要。最近の2skipは配布exeの隔離・資源展開と強制終了後の保存/二重実行拒否が未検証という意味。ソース版E2Eの成功に含めない。

## 推奨tier（提案のみ）

| tier       | 頻度                   | 対象                                                                                                      |
| ---------- | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| 編集時     | 関連変更のたび         | 関連unit/contract＋typecheck。wire/usage/approval/保存schemaを触ればその境界も含める                      |
| 節目       | 一つの実装単位の完成時 | 関連integration、対象fake GUI、lint/format、必要なbuild。今回ならJob、DAG/worktree、復元、workflow IPC/UI |
| リリース前 | 配布対象コード確定時   | full、全fake GUI、両build、指定exeでpackaged/portable E2E。Windows実体で条件付きテストを確認              |

承認・認証、保存/復元、二重実行、usage、不明カバー率、新旧adapter契約は削減対象ではなく、担当tierと一つの代表故障に対応付ける。全回帰はtier切替を確認する初回と最終/リリース前に行い、文書だけの変更や棚卸しで繰り返さない。

証拠: `.out/official-workflow-ui-final-vitest.json`、`.out/official-workflow-ui-final-gui.log`、`.out/official-workflow-ui-final-gui-rerun.log`、`vitest.config.ts`、`playwright.config.ts`。この棚卸し後の新DAG/Jobテストは別の検証記録に記載する。

## 後続検証で追加された待機問題

Job/DAGの実装節目に必要な最終回帰（`5d9d0ad`）で、既存 `improvement-boundaries.test.ts` のprovenanceケースがidle待機5秒でtimeoutした。全体は201ファイル・1802合格/1失敗。分離した既存ファイルは5件合格（2.50秒）。全fake GUIでは既存model-candidatesがprompt有効化待機10秒でtimeoutし、23合格/1失敗/2skip。分離すると1件合格（1.7秒）。新workflow関連57ケース・新UI2ケースは全体実行で合格した。

この二件もtiming問題の調査候補に追加する。既存コードを変更していない事実と分離再実行合格から、新workflowの故障と断定する根拠はないが、原因を解決したとも言わない。terminal state・保存済みtask・権限待ち・turn errorを区別するfixture診断と、実行時間の確認を推奨する。固定timeoutを延ばすだけの修正や自動retryはしない。初回の失敗と再実行結果を別に残し、棚卸し目的の全回帰を追加反復していない。
