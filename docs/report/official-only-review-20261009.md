> 過去の記録：移動元 `docs/official-only-review-20261009.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# 公式共通化の独立レビューと検証根拠（2026-10-09）

後続の残存2件修正・全回帰1回の結果は [最新検証記録](remaining-failures-regression-20261009.md) に記録した。以下の独立レビューはその時点の限定範囲であり、後続全回帰の52失敗を合格扱いするものではない。

対象は文書整備後6370866からf292b0fの変更と、今回のheadless追加修正。別担当 `/root/independent_review` が編集せずにコード・削除テスト・限定試験を確認した。Windows、実モデル、全回帰、インストール、認証/ACL変更は対象外。push/mergeなし。検証記録全文は [本記録](official-only-consolidation-20261009.md)。

## 共通経路・モデル・承認のコード根拠

| 境界           | 根拠                                                                                                                                                                                      | 確認した事実                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GUI入口        | [index.ts](../../src/main/index.ts) officialDefault/officialOnly分岐とofficialWorkflow生成                                                                                                | SessionController.officialSessionは同じservice.submitSessionを呼ぶ。通常providerは停止stub、fallbackは空。非公式起動は明示隔離fake fixtureだけ                                                        |
| headless入口   | [headless.ts](../../src/headless.ts) ensureService/officialSession                                                                                                                        | 同じSessionControllerとOfficialWorkflowService、ClaudeSdkManager/managedClaudeStart/ClaudeWorkflowAgent。model/effort/cwdは共通submissionへ。初期SDK準備時刻はGUI起動時とheadless実要求時で異なる     |
| 選択モデル     | [turn.ts](../../src/main/session/turn.ts) runOfficialSessionTurn、[catalog](../../catalog/models.yaml)                                                                                    | 共通resolverと有効catalogで解決。question役は同社Haiku/Luna、作業mainは選択モデル。旧IDは履歴識別のため残すが無効モデルを送信候補にしない                                                             |
| 公式のみ       | [controller.ts](../../src/main/session/controller.ts) sendPrepared、[context.ts](../../src/main/session/context.ts) defaultTools/sessionTools                                             | 公式分岐が旧provider選択より先。通常registryは空、隔離connection-testだけ固定EvalEcho。HTTP SDK fallbackなし                                                                                          |
| 計画/操作承認  | [service.ts](../../src/main/workflow/official/service.ts) command、[headless.ts](../../src/headless.ts) approval branch                                                                   | GUI/headlessは同じapprove/tool_decision endpointへid/digestを渡す。request/nonce/期限と禁止境界は共通。headlessはTTYで明示yのみ、非TTYは取消し保存を待って終了1。queued yを追加モデル入力にも使わない |
| sandbox        | [codex.ts](../../src/main/workflow/official/codex.ts)、[claude.ts](../../src/main/workflow/official/claude.ts)                                                                            | 同じ公式agentsを使う。Codex読取はread-only/never、実装はworkspace-write/untrusted、networkAccess:false。Claudeはphase別公式toolsと領域検査。追加permissionや禁止操作を端末で緩和しない                |
| 保存/取消/排他 | [controller.ts](../../src/main/session/controller.ts)、[turn.ts](../../src/main/session/turn.ts)、[home-writer.ts](../../src/main/home-writer.ts)                                         | cwd directory確認、履歴I/O後worktree/writer再確認、abort検査。finishTurnはappend/save後idle通知。headlessはshutdown/close後home writer解放                                                            |
| 旧ID/旧履歴    | [headless.ts](../../src/headless.ts) open、[catalog-compat tests](../../src/main/workflow/official/catalog-compat.test.ts)、[controller tests](../../src/main/session/controller.test.ts) | 旧IDや保存JSONLを強制変換/削除しない。headless旧会話は閲覧専用、GUIの完了済み保存会話への利用者の新規送信は公式入口へ。直近履歴は非信頼参考データ。未完了旧タスクは引継ぎ拒否                         |

## 撤去範囲と残す処理

旧HTTPAdapters、Auth login/refresh/RefreshingProvider、WorkflowRuntime/Worker/ChildRunner/Taskと予約scheduler、旧送信slash実行を撤去した。旧34モデル公開ツールは登録経路から外し、定義32個を削除した。ListProjectSkills/LoadProjectSkillの2wrapperは [skill-ui.ts](../../src/main/session/skill-ui.ts) の手動IPC validator/PermissionGate/trace専用であり、モデルへ渡さない。

FileAccess共通境界を抽出し、履歴/memory/skills/レポート/旧record decoder・serializer/隔離固定fixtureを維持する。core.loopや資格情報reader/spikeが残ることは、通常GUI/headlessでの実HTTP実行を意味しない。report-demoの子実行は静的記録fixtureへ変更した。[全変更TSV](official-only-changes-20261009.tsv)でA/M/D/Rを確認できる。

## UI/skillsの追加仕様

[PromptLine](../../src/renderer/components/PromptLine.tsx)は公式入力で/stopだけを候補にし、旧slashと画像を送信前に拒否。[Transcript](../../src/renderer/components/Transcript.tsx)は旧MCP/phase履歴を表示するが操作を無効化する。旧画像・質問履歴の閲覧や手動テキスト返信は保存/UI testsで保護する。自動対象列挙・既存Node/Vitestテスト必須という旧説明を判別promptと画面から外した。

[SkillsManager](../../src/renderer/components/SkillsManager.tsx)はクリック後に同source/hashをpreview IPCで再確認し、[main skill UI](../../src/main/session/skill-ui.ts)の既存validator・scope・秘密検査・許可確認を通す。[skillReferenceSubmission](../../src/shared/project-skills.ts)はname/description/source/hash/bodyの全量を非信頼JSON参考資料として通常sendへ渡す。4000文字上限、省略・版変化・未対応付属資料は拒否。本文指示/script/install/SDK skills/MCP有効化ではなく、受付を永続登録成功と表示しない。セッション切替・取消後の遅延previewは送信しない。

## テスト撤去/移行の分類と代替確認

削除したtestファイルは47件。[全47件の分類TSV](../verification-20261009/deleted-test-classification.tsv)は6370866→f292b0fのD対象だけを列挙する。ファイル単位の撤去と、共通suite内の旧case除去/公式fixtureへの移行を区別する。

| D対象分類                   | ファイル数 | 廃止理由/代替確認                                                                                                              |
| --------------------------- | ---------: | ------------------------------------------------------------------------------------------------------------------------------ |
| 旧HTTP思考結合spike         |          1 | 旧HTTP結合の実験。公式モデル証跡は公式adapter/testsで別に扱う                                                                  |
| 旧Task/workflow実行器       |         13 | 廃止した子実行/旧段階/scheduler固有契約。公式service/native testsと固定課題testsを保持、親子レポートは静的記録fixture          |
| 旧ログイン/refresh          |          7 | 旧アプリ内自前認証更新を廃止。session/authenticationはunsupported理由/資格情報を扱わない境界を検証、公式認証契約は公式agents側 |
| 旧送信/圧縮/MCP/quota継続   |          8 | 旧自動再送・旧prefix・旧MCP操作の契約を廃止。保存/取消/排他/旧記録/耐久quota-pauseと拒否境界を保持                             |
| 旧HTTP Adapter/予算ラッパー |          3 | 旧HTTP通信/retryを廃止。serializer/stream decoderの保存互換、公式catalog/role、公式通信境界を別に検証                          |
| 旧モデル公開ハーネスツール  |         15 | 旧Read/Write/Bash/background/Web等のtool契約を廃止。共通FileAccess/checkpoint、履歴/手動UI/秘密除去のtestsを保持               |

共通suiteは、controllerの保存/モデル/旧既定値/cwd/取消/重複/export、early-send-cancellation、session-boundaries、storage-consistency、project-history/memory/skills integration、report/HTML、App/PromptLine/Transcript/SkillsManager、headlessへ公式mock/静的fixtureとして移行した。FileCheckpointStoreのpreview/restore14ケース、FileAccess2ケース、保存画像/秘密除去を維持する。旧/undoは実行せず、file/history/checkpoint不変を検証する。

これは旧ツールと公式SDKの同等カバレッジを意味しない。旧Read/Writeの文字コード/改行/複数編集契約を削除したことで、公式SDKで同じ品質が保証されたとは説明しない。native品質・Windows実機・実モデルは未確認。残る失敗のproject-memory.test.tsとservice.test.tsを削除/skip/timeout変更していない。

## 残る2失敗と現行への影響

| 事項                      | 変更前再現証拠                                                                                                                                                                                                                    | 現行への影響/限界                                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory異cwd list拒否      | [6370866ログ](../verification-20261009/baseline-6370866-memory.log)、assert161で拒否ではなく空entries。共通projectHistoryAccess本文は基準と同一                                                                                   | 手動memoryのこの入口は明示拒否仕様/テストを満たさない。今回の356統合の1失敗。返ったデータは空で、他の読取/書込や漏洩をこの結果だけから推測しない。既存問題として記録のみ           |
| 固定課題の取消/再開後完了 | [6370866ログ](../verification-20261009/baseline-6370866-fixed-resume.log)、service.test.ts270の20秒完了待ち失敗。[診断](../verification-20261009/fixed-resume-observation.json)は独立checks exitCode:null/passed:falseとattention | 固定課題のこの独立プロセス検証を成功と扱えない。通常nativeValidation報告とは別経路だが、実機/実モデルも未試験なので一般の成功保証へ拡張しない。原因確定/実装修正は今回行っていない |

356成功/1失敗/3Windows skipは [f292b0f限定38ファイルログ](../verification-20261009/scoped-suite-f292b0f.log)。この失敗はmemoryだけ。固定再開は別service単独実行であり、失敗2事項と1失敗集計は矛盾しない。service判別4成功は別の4ケース選択で、service全体の成功ではない。

## 独立レビュー結果と修正

指定境界に重大な欠陥は見つからなかった。別担当は4ファイル50成功、別3ファイル30成功/2skip、最終headless17成功を確認した。実行には重複があり合算しない。

レビューで見つけたheadlessの非TTY入力終了と承認不能後queued入力の問題を修正。閉じた非TTY pipeの質問は処理/保存し、TTY終了後buffer指示はdispatchしない。非TTY承認不能は取消・保存/idle後終了1、pipeのyを承認にも追加モデル入力にも使わずsubmitSession1回。SIGINT/TTY実行中EOF/stopの取消を保持する。閉じたpipeはbaselineでも成功しなかったので、新規退行と断定せず今回のheadless仕様を満たす修正として扱う。[最終headlessログ](../verification-20261009/headless-review-final.log)。
