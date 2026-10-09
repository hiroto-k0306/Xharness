# チャット承認とWindows通知・第1段階（2026-10-09）

公式スキル追加後の `f2d6db1` を起点とするUIの第1段階です。通常会話の承認場所と通知を変更し、承認そのものの権限を広げません。新しいOld snapshotは作成していません。現行要件は [SPEC §10](../SPEC.md#10-画面停止レポート)。

第1段階時点の記録です。後続で通常専用画面の撤去・設定/証跡の移設・rewindのチャット移動と限定DAGを追加しました。現在の対応/停止境界は [第2段階記録](chat-layout-native-dag-20261009.md) を参照してください。

## チャット内の確認

計画/操作承認は現在のTranscript内に置き、保存された会話IDに一致するpending recordだけを表示します。cwdが同じでも別会話の承認を表示しません。既存PermissionInline/PlanApprovalもTranscript内です。旧RewindApprovalは会話画面内の別領域に残り、通常公式の巻き戻し操作を追加しません。通常詳細パネルは承認操作を持たない参照表示として残ります。会話に属さない明示模擬/verification固定課題の開発確認は、通常会話の承認とは別です。

計画はworkflow ID・保存会話ID・承認UUID・digest・10分期限に結び付け、許可/拒否を一度だけ受理します。operationは既存のnative session/thread IDを保持したままconversationSessionIdを別に照合します。計画のフロー許可も会話に結び付けます。期限切れ・停止後・会話/ID/digest不一致・二重応答は許可せず、再起動時にpending許可を復元しません。renderer送信失敗を自動再送しません。

チャットには計画本文/担当/依存/候補ファイル/検証案/作業場所と直接編集の説明、操作全文/対象/理由/期限を表示します。許可の移動でnative sandbox、禁止操作、個別承認、停止、変更保全の境界を緩めません。headlessも共通serviceのUUID/会話/期限を送る承認protocolへ追従します。入力・出力ともTTYの条件と非TTYの理由付き停止は維持します。

## Windows通知

通知は新しい承認/入力待ちと終了/停止の状態遷移を固定文面で知らせます。会話本文・操作全文・ファイルパス・秘密を通知へ出しません。クリックは現在存在する既知会話を開き、該当承認へfocusするだけで、許可/実行/再送をしません。

初期の保存履歴を通知せず、同じapproval ID/digestの重複、同じ終了状態の重複、workflow終了とturn idleの二重通知を抑えます。通知は保存済み証拠や状態遷移の正しさを追加保証する機能ではありません。OS非対応/表示・focus失敗は実行を妨げません。Windowsかつ非fakeかつElectron Notification対応時だけ表示し、OS通知設定・権限・認証を変更しません。

Windows通知にはStart Menu shortcutと対応AppUserModelID等の条件があります。この実装はbuilderのappIdと一致する `local.xharness.app` をprocessへ設定しますが、shortcut登録や実インストールを今回検証/変更していません。API対応の判定だけでOS表示の成功を保証しません。[Electron公式のWindows通知条件](https://www.electronjs.org/docs/latest/tutorial/notifications#windows)。

## 実装根拠

- [ChatOfficialApprovals](../src/renderer/components/ChatOfficialApprovals.tsx): 保存会話の一致、計画/操作全文、期限、1回送信、通知focus。
- [App](../src/renderer/App.tsx)、[Transcript](../src/renderer/components/Transcript.tsx): チャット内の確認と通知先会話の選択。
- [OfficialWorkflowPanel](../src/renderer/components/OfficialWorkflowPanel.tsx): 通常会話の承認をチャットへ誘導、明示開発経路の分離。
- [service](../src/main/workflow/official/service.ts)、[operation-approval](../src/main/workflow/official/operation-approval.ts): 期限/UUID/会話検査、拒否/取消/フロー許可。
- [IPC](../src/main/official-workflow-ipc.ts)、[headless](../src/headless.ts): 型付き承認protocol。
- [UserNotifications](../src/main/notifications.ts)、[Electron接続](../src/main/index.ts): 固定文面、初期抑制/重複抑制、既知会話focus、非阻害。

## 限定検証と未確認

Linux・Node24.19.0・既存node_modulesで、mock/fixture・renderer対象テスト・直接関連の承認/通知テストを統合実行し、13ファイル178件成功・失敗0（13.24秒）。承認service/操作/IPC、通知、headless、チャットカード/詳細panel/Transcript/App/storeを対象にし、通知12件を重複加算しません。型検査も成功。最終HEADは作業完了報告で示します。実モデル通信、実Windows通知の表示/クリック、Windows GUI/配布・インストールの成功は今回未確認です。過去のWindows限定48件成功や公式スキルmock成功を、このUI変更の実機成功へ読み替えません。

## 別段階・未実装の範囲

次段階の通常詳細パネル撤去、固有設定の移設と記録証跡のReceiptsへの移設は、第1段階の完了とは別です。計画の依存関係から通常native DAGを判断・並列実行する追加変更も別段階であり、この記録の検証証拠に混ぜません。

新しい評価案では「実績不足」というUI表示を設けず、内部ではsample件数/欠測を考慮する設計判断を記録します。この評価機能自体は今回未実装です。既存の手動比較DB/UIの削除と、過去履歴評価をモデル選択へ結び付ける処理も別段階であり、今回完了していません。review重大度・修正結果・usage・所要時間をplannerへfeedbackする評価目的も、チャット承認/通知だけでは実装されません。現行改善UI/記録はその追加評価ループの証拠ではありません。
