# XHarness 現行設計書

基準: 2026-10-09、main `f7f7350`を起点とする今回のalias最新追従後のコード。desktop/headlessの旧HTTP実行と旧モデルツールを廃止した設計説明です。動作の要件は [SPEC.md](SPEC.md)、検証状態は [公式共通化記録](docs/official-only-consolidation-20261009.md)、初回の文書照合は [文書照合記録](docs/documentation-refresh-20261009.md)。旧フェーズ設計・未実装案は [旧設計](Old/DESIGN-9a275bc.md) と [Old索引](Old/README.md) に保存します。

## 1. プロセスと経路

rendererは会話・モデル選択・計画/操作承認・履歴/LoopFlowを表示し、preload/sharedの型付きIPCでmainへ操作を渡します。mainがセッション、ファイル、子プロセス、モデル接続、記録を管理します。資格情報はrendererへ渡しません。公式workflowと保存・検査の共通処理はElectronに依存させません。

| 経路              | 所有する処理                                                                                | 主なコード                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| desktop通常起動   | 公式Claude Agent SDK / Codex App Server。旧HTTPの資格情報reader/更新器/fallbackを接続しない | [index.ts](src/main/index.ts)、[turn.ts](src/main/session/turn.ts)                                                                   |
| 公式通常作業      | 判別、計画承認、公式nativeツール、テスト報告、別会社レビュー/修正                           | [service.ts](src/main/workflow/official/service.ts)、[native-runtime.ts](src/main/workflow/official/native-runtime.ts)               |
| 固定課題・模擬DAG | 専用workspace、登録テスト、コミット、独立検証、安全checkpoint                               | [公式workflow](src/main/workflow/official/)、[単一課題](docs/official-workflow-single-task.md)、[DAG](docs/official-workflow-dag.md) |
| headless          | GUIと同じSessionController officialSession→OfficialWorkflowService。TTY承認と端末管理操作   | [headless.ts](src/headless.ts)、[terminal.ts](src/headless/terminal.ts)                                                              |

旧HTTP Adapter、自前Auth更新、旧Agent Loop、旧workflow/workerと34旧モデル公開ツールを現役経路から除去します。旧記録の読取型・レポート・現役手動UIのscope/validatorは必要な共通処理として残し、モデルへ再登録しません。明示connection-testのEvalEcho等は通常実行とは別の開発fixtureです。通常入力は画像・旧slashを拒否し、適用できない旧ルール/フック/通信上限設定も停止対象です。headlessの端末専用コマンドはモデルへ旧slashを送る経路ではありません（SPEC §11）。

## 2. 通常作業の状態と比較基準

1. 同じ会社のroles.questionで直近10メッセージを参考に判別します（1回、60秒、ツールなし）。質問なら回答して終了します。
2. 作業なら開始時snapshotを取り、選択メインモデルが公式ツールで読取探索・計画します。clean Git、事前ファイル列挙、既存テストの指定を条件にしません。
3. 計画を依頼・cwd・snapshot digestへ結合し、利用者に承認を求めます。承認中に比較対象が変われば停止します。
4. 既存cwd/既存worktreeへ直接実装し、公式エージェントがテストを選択・追加・実行して報告します。自動worktree/copy/Git初期化/commitは行いません。
5. 開始時と終了時の固定before/after/hashと実行報告を別会社へ渡します。重大指摘/failed報告なら最大2修正、変化なしは成功にしません。判別後の呼出は最大7回、工程120秒（承認待ちを除く）。

snapshotは秘密名・リンク・依存物・生成物等を除き、10,000ファイル、8 MiB/ファイル、128 MiB合計、深さ40で制限します。レビュー内容は合計4 MiBまでです。Git HEADとは異なり、開始前の編集を比較基準に含めます。除外領域や外部shell副作用の完全追跡・自動復元ではありません。

通常作業の計画は [native-dag.ts](src/main/workflow/official/native-dag.ts) の必須parallelizationで直列/並列と理由を決めます。直列1taskは既存直接編集へ戻ります。並列はclean Git・exact scope・最大2並行を条件に [project-dag-workspace](src/main/workflow/official/project-dag-workspace.ts) の所有detached worktreeへ限定し、元checkoutを変更しません。未解決条件/競合/範囲外変更は停止します。

独立検証は統合後のexact Node testと別のコード実行承認が必要です。本番はcreateValidationRuntimeで対応schema、合成ファイルの境界、localhost通信拒否、取消/所有プロセス終了、CLI/Node identityを確認し、成功時だけApp Server command/exec検証portを接続します。未対応の並列計画は計画承認/実装前に停止します。終了確認が不確定なら直列も開始せず保全します。対象Windowsでの実確認は未実施です。fake公式agents・real Git・固定Node fixtureでの実装検証と、本番sandbox/Windows/実モデル成功を分けます。各node/統合callのalias/skillを再検証し、Claudeは元sourceへ固定した選択bundleだけをworktreeの一時pluginへ渡します。Codex選択skillは既存の隔離未確認停止を維持します。推定時間を作らず、完了履歴の数値実績を完全モデルID/effort・課題種別/難度で分けて通常plannerへ渡します。選択はLLMに残し、catalog制約を維持します。[実績feedback](docs/model-performance-feedback-20261009.md)。

## 3. ツール・承認・OS境界

| 境界            | 実装                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude          | 読取phaseはRead/Glob/Grep、実装/fixはEdit/Write/NotebookEditと承認付きBash。作業領域のファイルを検証。背景Bash/子委託は無効                                                           |
| Codex           | 通常nativeは読取phaseもhost/shellを有効にするが、read-only sandbox・networkAccess:false・approval neverを維持。実装/fixはworkspace-write/untrusted。固定課題のscope/command制限と区別 |
| 操作許可        | workflow/request/session/turn/item/内容digest/nonce/10分期限へ結合。今回またはworkflow/cwdのみのフロー許可。自動モードも計画承認が必要                                                |
| 禁止境界        | 追加permission/network、既知の秘密、範囲外移動、reset/clean等は拒否。フロー許可でも解除しない。任意shellの意味を完全解析する保証はない                                                |
| phase時計       | 重なる承認待ちは和集合を除外し、最後の応答で再開。閉じた時計を遅延応答で再設定しない                                                                                                  |
| Windowsプロセス | Jobへ停止状態で所属させ、親lease/取消/timeoutで子孫を停止。包含不能なら実行しない。filesystemの完全隔離ではない                                                                       |
| 子の環境        | 許可リストでPATHEXTを引継ぎ、子起動前PSModulePathを除去。APIキー/NODE_OPTIONSの混入を避ける                                                                                           |

根拠: [claude.ts](src/main/workflow/official/claude.ts)、[codex.ts](src/main/workflow/official/codex.ts)、[operation-approval.ts](src/main/workflow/official/operation-approval.ts)、[phase-timer.ts](src/main/workflow/official/phase-timer.ts)、[owned-process.ts](src/main/workflow/official/owned-process.ts)、[workspace.ts](src/main/workflow/official/workspace.ts)。

通常の承認UIは [ChatOfficialApprovals](src/renderer/components/ChatOfficialApprovals.tsx) を現在のTranscript内へ置き、recordの保存会話IDと一致する承認だけを表示します。mainも会話/UUID/digest/10分期限を照合し、native threadとアプリ会話のIDを別々に保持します。通常workflow専用画面を通常UIから撤去し、SDK接続設定はOfficialRuntimeSettings、保存された全証跡は会話のOfficialWorkflowReceipts、rewind確認もTranscript内へ移します。verificationOnlyの開発確認パネルは残します。

[UserNotifications](src/main/notifications.ts) は固定文面とlive transitionだけを使い、初期履歴/重複通知を抑えます。Electron接続はWindowsかつOS対応時だけ表示し、クリックは既知会話へ移動する操作です。通知失敗は非阻害で、許可・再送・OS設定変更をしません。実Windows未確認。[第1段階記録](docs/chat-approvals-notifications-20261009.md)。現行の第2段階は [画面整理・限定DAG記録](docs/chat-layout-native-dag-20261009.md) を参照します。

## 4. モデルと公式runtime

[catalog/models.yaml](catalog/models.yaml) と [catalog.ts](src/main/config/catalog.ts) のnormalizeModelPolicy/resolveModelPolicyを使います。保存選択はprovider:aliasと別のeffort、送信IDは開始/安全再開/各call直前の現カタログで解決します。有効aliasはopus/sonnet/haiku/astra/sol/luna。解決した実ID/effort/catalogは1通信中固定し、次callで再解決します。未知/競合/無効/effort非対応/公式利用不能なら停止し、別モデル/会社/HTTPへfallbackしません。

historicalIdsはカタログに明示された同じprovider/familyの旧IDだけを将来の選択policyへ対応付けます。名前や世代番号から推測しません。過去recordの実ID/effort/catalog/plan/digestは維持し、policyとcall.modelSelectionを追記します。modelSelectionはpolicy/今回resolved/previous/changedを分離し、UIは記録された実行事実を表示します。旧callの未記録policy/catalogを現一覧で補完しません。SDK版固定とモデルalias最新追従は別の層です。

公式Claude SDKは配布resourceのseedから管理フォルダーへ準備し、専用Workerで使用します。各タスクにSDK版を固定し、更新途中で差し替えません。24時間ごとのstable更新確認は既知の0.3.x互換範囲と検査を通った版だけを適用します。SHA512、archiveパス/API宣言/importを検査し、install scriptやCLIを起動せずactive pointerを切り替えます。構造検査は将来の実通信成功の保証ではありません。

Codexは明示exeを優先し、未指定のAppX探索と管理領域への必要runtimeコピーを行います。欠損・不正な実行環境からsandboxやHTTPを緩めた経路へ逃がしません。SDK seedはbeforePackで検査・同梱し、app.asarだけでなく外部resourceも配布の同一性を確認します。詳細はSPEC §15と [runtime追従](docs/official-runtime-updates-20261008.md)。

## 5. 保存・表示・再開

通常作業のテストはnativeValidationのモデル報告であり、独立process/checksではありません。未テスト・失敗・出典をGUI/LoopFlow/HTML/引継ぎで区別します。固定課題は独立テストとHEAD照合を別に保存します。

request IDごとに指示/構造化応答を各24,000文字、公開イベントを128件/64,000 UTF-8バイト/本文4,000文字まで選別保存します。思考・認証・画像音声本体を除去し、欠測/省略/旧記録本文なしを表示します。SDK内部の全HTTP往復は保存・再現しません。保存失敗はphase停止対象です。

通常作業は再表示だけで、自動resume・query再送・pending承認復元をしません。起動時の未完了記録はinterruptedにします。新しいalias対応sessionの再開も既存安全checkpointの境界に限定し、不確定な副作用を自動再送しません。過去ID/plan/digestを維持し次のcallを解決します。固定課題の安全checkpoint、旧Agent Loop記録の閲覧とは別です。headlessの旧会話は閲覧専用とし、/clearから新しい公式セッションを作ります。GUIも旧実行器を復元しませんが、完了済みの保存会話へ利用者が新しく送る入力は公式入口を通り、直近履歴を参考データとして渡します。旧未完了タスクの引継ぎは拒否します。保存homeの単一writer・セッション削除の排他と、worktreeの確認付きkeep/merge/removeは維持します。

## 6. 参考スキルと端末UI

workspace選択時のメモリ・受渡し・ローカルブラウザーは明示手動UI/IPCとして残します。手動改善版比較のUI/IPC/専用実装は利用者指定で退役し、既存比較DBを保持します。旧IPCは廃止理由で拒否し、専用ソースは [Old対応表](Old/retired-sources/manual-improvements-bcca4826/manifest.tsv) に保存します。quota観測のcandidate-quotaと共通型、受渡し/ブラウザー用fixtureは分離して保持します。通常作業のレビュー修正やモデル実績feedbackと混同しません。現役の手動操作は既存のvalidator/scope/PermissionGateを通し、旧toolsを公式モデルへ登録する経路にはしません。

SkillsManagerの明示送信は、mainのpreview IPCでsource/hashを再確認して既存許可を通し、非信頼JSONの本文/出典情報を通常sendへ渡します。全量4000文字以内・非省略に限定し、超過を切り詰めません。SDK skills/MCP/権限・scriptを有効化せず、永続登録ではありません。成功表示は通常sendの受付であり、旧LoadProjectSkillレシート成功とは区別します。付属資料は版確認/プレビューのみで送信未対応です。セッション切替/取消後の遅延previewは無効化します。

公式スキルの明示選択は参考資料sendと別に、固定provider rootと既存PermissionGateから本文/hash/bundleHashを検査して保存します。関連資料はmd/txt/rst最大20ファイル・全量16KiBのみ。選択・送信準備・各工程callで再検証し、変更/未対応を省略・別版置換しません。Claude通常nativeのplan/implement/review/fixでは選択bundleだけの一時local pluginとSkill gateを使い、settingSourcesや未選択plugin/MCP/agents/hooksを有効化しません。質問/固定scope/模擬DAGは未対応です。

Codexは候補列挙/プレビュー/選択だけを扱います。未選択skill discoveryを隔離できる保証が未確認なので、Codex選択を含むworkflowはserviceのpreflightで分類通信・planner・App Server起動前に停止recordを保存します。adapterにも起動前の拒否を残します。requested/dispatched/observedのrequested・allowed・completed・deniedを分け、初期化/usageを実使用証跡へ昇格しません。提供元の作成認定・安全認定とは別です。詳細は [公式スキル](docs/official-skills-20261009.md)。

headlessは実行要求時に共通OfficialWorkflowServiceを準備します。入力・出力ともTTYの場合だけ計画/操作を承認でき、非TTYの承認要求は取消・理由表示・終了1です。非TTYのEOFは入力完了であり受領済みの質問を処理します。TTYの実行中EOF/Ctrl+Cは取消・終了130。report/replayはモデル初期化なしの読取互換経路で、旧資格情報readerを使いません。旧sessionのresumeは保存値を保持して閲覧し、公式作業の自動再開ではありません。

## 7. 配布・検証・将来項目

Windows配布はNSIS/portable exe、利用者READMEとSHA256SUMSをリポジトリ外へ収集します。クラウドではexe・インストール・ACL/認証変更・実モデル試験を行いません。実装済み、モック検証済み、過去の実機成功、最新版で未確認を分けます。

最新記録では環境修正後の文書課題が実機で完了しましたが、全回帰は模擬DAG1件timeoutです。PR #25はその1件だけ60秒に変更し、Linux限定117件成功・当時Windows必須3件未確認でした。後続Windows48件結果は下記の別記録です。今回の公式専用化・headless移行・参考スキル連携は実機再実行ではありません。過去の117件成功を今回変更の検証結果へ読み替えません。

本番native DAGの実行成功、通常作業の自動再開、全shell副作用の復元、全モデル/effort互換性、他PC/Store版pwsh、最新main Windows配布の成功は保証しません。旧設計のフェーズ順・将来案は採用済み要件にしません。分類promptは今回の探索方式へ更新しました。Codex読取phase設定の意図・経緯などの要確認事項はSPEC §16に記録します。

[Windows48件の記録](docs/windows-pr26-validation-20261009.md)はfce9ebaの限定結果で、今回のalias対応をWindows/実モデル/GUI/配布で検証した記録ではありません。変更前設計は [DESIGN-f7f7350](Old/DESIGN-f7f7350.md)。
