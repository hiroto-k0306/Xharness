# XHarness 現行設計書

基準: 2026-10-09、main `9a275bc99272b34f0c418a59a8fcc63dcabd20fe`を起点とする今回の公式専用化後のコード。desktop/headlessの旧HTTP実行と旧モデルツールを廃止した設計説明です。動作の要件は [SPEC.md](SPEC.md)、検証状態は [公式共通化記録](docs/official-only-consolidation-20261009.md)、初回の文書照合は [文書照合記録](docs/documentation-refresh-20261009.md)。旧フェーズ設計・未実装案は [旧設計](Old/DESIGN-9a275bc.md) と [Old索引](Old/README.md) に保存します。

## 1. プロセスと経路

rendererは会話・モデル選択・計画/操作承認・履歴/LoopFlowを表示し、preload/sharedの型付きIPCでmainへ操作を渡します。mainがセッション、ファイル、子プロセス、モデル接続、記録を管理します。資格情報はrendererへ渡しません。公式workflowと保存・検査の共通処理はElectronに依存させません。

| 経路              | 所有する処理                                                                                | 主なコード                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| desktop通常起動   | 公式Claude Agent SDK / Codex App Server。旧HTTPの資格情報reader/更新器/fallbackを接続しない | [index.ts](src/main/index.ts)、[turn.ts](src/main/session/turn.ts)                                                                   |
| 公式通常作業      | 判別、計画承認、公式nativeツール、テスト報告、別会社レビュー/修正                           | [service.ts](src/main/workflow/official/service.ts)、[native-runtime.ts](src/main/workflow/official/native-runtime.ts)               |
| 固定課題・模擬DAG | 専用workspace、登録テスト、コミット、独立検証、安全checkpoint                               | [公式workflow](src/main/workflow/official/)、[単一課題](docs/official-workflow-single-task.md)、[DAG](docs/official-workflow-dag.md) |
| headless          | GUIと同じSessionController officialSession→OfficialWorkflowService。TTY承認と端末管理操作   | [headless.ts](src/headless.ts)、[terminal.ts](src/headless/terminal.ts)                                                              |

旧HTTP Adapter、自前Auth更新、旧Agent Loop、旧workflow/workerと34旧モデル公開ツールを現役経路から除去します。旧記録の読取型・レポート・手動UIのscope/validatorは必要な共通処理として残し、モデルへ再登録しません。明示connection-testのEvalEcho等は通常実行とは別の開発fixtureです。通常入力は画像・旧slashを拒否し、適用できない旧ルール/フック/通信上限設定も停止対象です。headlessの端末専用コマンドはモデルへ旧slashを送る経路ではありません（SPEC §11）。

## 2. 通常作業の状態と比較基準

1. 同じ会社のroles.questionで直近10メッセージを参考に判別します（1回、60秒、ツールなし）。質問なら回答して終了します。
2. 作業なら開始時snapshotを取り、選択メインモデルが公式ツールで読取探索・計画します。clean Git、事前ファイル列挙、既存テストの指定を条件にしません。
3. 計画を依頼・cwd・snapshot digestへ結合し、利用者に承認を求めます。承認中に比較対象が変われば停止します。
4. 既存cwd/既存worktreeへ直接実装し、公式エージェントがテストを選択・追加・実行して報告します。自動worktree/copy/Git初期化/commitは行いません。
5. 開始時と終了時の固定before/after/hashと実行報告を別会社へ渡します。重大指摘/failed報告なら最大2修正、変化なしは成功にしません。判別後の呼出は最大7回、工程120秒（承認待ちを除く）。

snapshotは秘密名・リンク・依存物・生成物等を除き、10,000ファイル、8 MiB/ファイル、128 MiB合計、深さ40で制限します。レビュー内容は合計4 MiBまでです。Git HEADとは異なり、開始前の編集を比較基準に含めます。除外領域や外部shell副作用の完全追跡・自動復元ではありません。

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

## 4. モデルと公式runtime

[catalog/models.yaml](catalog/models.yaml) と共通resolverがID/alias/能力/effort/役割を解決します。有効aliasはopus/sonnet/haiku/astra/sol/lunaだけです。旧Haikuを含む無効モデルのIDは履歴識別用に保持し、実行許可にしません。候補は公式接続一覧と通常枠に照合し、未知・不足・経路不明なら停止します。desktop/headlessはHTTP・他モデル・他社へ暗黙fallbackしません。

公式Claude SDKは配布resourceのseedから管理フォルダーへ準備し、専用Workerで使用します。各タスクにSDK版を固定し、更新途中で差し替えません。24時間ごとのstable更新確認は既知の0.3.x互換範囲と検査を通った版だけを適用します。SHA512、archiveパス/API宣言/importを検査し、install scriptやCLIを起動せずactive pointerを切り替えます。構造検査は将来の実通信成功の保証ではありません。

Codexは明示exeを優先し、未指定のAppX探索と管理領域への必要runtimeコピーを行います。欠損・不正な実行環境からsandboxやHTTPを緩めた経路へ逃がしません。SDK seedはbeforePackで検査・同梱し、app.asarだけでなく外部resourceも配布の同一性を確認します。詳細はSPEC §15と [runtime追従](docs/official-runtime-updates-20261008.md)。

## 5. 保存・表示・再開

通常作業のテストはnativeValidationのモデル報告であり、独立process/checksではありません。未テスト・失敗・出典をGUI/LoopFlow/HTML/引継ぎで区別します。固定課題は独立テストとHEAD照合を別に保存します。

request IDごとに指示/構造化応答を各24,000文字、公開イベントを128件/64,000 UTF-8バイト/本文4,000文字まで選別保存します。思考・認証・画像音声本体を除去し、欠測/省略/旧記録本文なしを表示します。SDK内部の全HTTP往復は保存・再現しません。保存失敗はphase停止対象です。

通常作業は再表示だけで、自動resume・query再送・pending承認復元をしません。起動時の未完了記録はinterruptedにします。固定課題の安全checkpoint、旧Agent Loop記録の閲覧とは別です。headlessの旧会話は閲覧専用とし、/clearから新しい公式セッションを作ります。GUIも旧実行器を復元しませんが、完了済みの保存会話へ利用者が新しく送る入力は公式入口を通り、直近履歴を参考データとして渡します。旧未完了タスクの引継ぎは拒否します。保存homeの単一writer・セッション削除の排他と、worktreeの確認付きkeep/merge/removeは維持します。

## 6. 参考スキルと端末UI

workspace選択時のメモリ・受渡し・改善・ローカルブラウザーは明示手動UI/IPCとして残します。既存のvalidator/scope/PermissionGateを通し、旧toolsを公式モデルへ登録する経路にはしません。今回のソース保持・オフライン確認は各機能の最新公式実機成功を保証しません。受渡しは保存公式記録の受動的な証拠参照、改善ケースの明示実行は通常sendの公式経路です。スキル等の内部wrapperに旧ツール名が残ってもモデルへの汎用登録は0です。共通helperの分離・内部wrapper整理は機能の再有効化とは別です。

SkillsManagerの明示送信は、mainのpreview IPCでsource/hashを再確認して既存許可を通し、非信頼JSONの本文/出典情報を通常sendへ渡します。全量4000文字以内・非省略に限定し、超過を切り詰めません。SDK skills/MCP/権限・scriptを有効化せず、永続登録ではありません。成功表示は通常sendの受付であり、旧LoadProjectSkillレシート成功とは区別します。付属資料は版確認/プレビューのみで送信未対応です。セッション切替/取消後の遅延previewは無効化します。

headlessは実行要求時に共通OfficialWorkflowServiceを準備します。入力・出力ともTTYの場合だけ計画/操作を承認でき、非TTYの承認要求は取消・理由表示・終了1です。非TTYのEOFは入力完了であり受領済みの質問を処理します。TTYの実行中EOF/Ctrl+Cは取消・終了130。report/replayはモデル初期化なしの読取互換経路で、旧資格情報readerを使いません。旧sessionのresumeは保存値を保持して閲覧し、公式作業の自動再開ではありません。

## 7. 配布・検証・将来項目

Windows配布はNSIS/portable exe、利用者READMEとSHA256SUMSをリポジトリ外へ収集します。クラウドではexe・インストール・ACL/認証変更・実モデル試験を行いません。実装済み、モック検証済み、過去の実機成功、最新版で未確認を分けます。

最新記録では環境修正後の文書課題が実機で完了しましたが、全回帰は模擬DAG1件timeoutです。PR #25はその1件だけ60秒に変更し、Linux限定117件成功・Windows必須3件未確認です。今回の公式専用化・headless移行・参考スキル連携は実機再実行ではありません。過去の117件成功を今回変更の検証結果へ読み替えません。

native DAG、通常作業の自動再開、全shell副作用の復元、全モデル/effort互換性、他PC/Store版pwsh、最新main Windows配布の成功は保証しません。旧設計のフェーズ順・将来案は採用済み要件にしません。分類promptは今回の探索方式へ更新しました。Codex読取phase設定の意図・経緯などの要確認事項はSPEC §16に記録します。
