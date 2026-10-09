# 会話・作業場所・利用者操作の仕様（What）

基準: 2026-10-09、`0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。要求の理由は [Requirements.md](Requirements.md)、実現方法は [Architecture.md](design/Architecture.md)。実装と直接テストの契約を記述し、Windows通知・最新配布・実モデルの成功保証を含めない。

## 1. 検証可能な要件

この表を会話機能の要件の正本とする。利用者ニーズの理由は [Requirements](Requirements.md)、外部から見える具体的なAPI・画面・状態は§2〜§6、合否を判定する受入条件は§7に分ける。

| ID      | 満たす条件                                                                                                          | 具体仕様 |
| ------- | ------------------------------------------------------------------------------------------------------------------- | -------- |
| SES-R01 | 会話IDと登録workspace/cwdを保存し、workspace未指定は専用scratchを使う。作業場所が不明ならfallbackしない             | §2       |
| SES-R02 | closeと確認付きdeleteを別操作にし、削除開始後の送信・後着保存で会話を復活させない                                   | §2〜§3   |
| SES-R03 | 同一実体homeのwriterを排他し、所有者不明のロックを回収しない。会話保存と削除を順序付ける                            | §3       |
| SES-R04 | 未確定なquery・副作用・承認を再起動で再送しない。会話の再表示と実行再開を別操作にする                               | §3       |
| SES-R05 | 通常承認は現在の保存会話に一致するチャットだけで表示・回答する。UUID/digest/期限はworkflow所有契約を適用する        | §4       |
| SES-R06 | Receiptsは既定closed、会話切替/再mountで閉じ、更新で自動展開しない。別会話や欠測証跡を推測で補わない                | §4       |
| SES-R07 | 通知は固定文面を使い秘密/本文/command/cwdを含めない。既知会話のfocusだけを行い、自動承認しない                      | §4       |
| SES-R08 | stdin/stdout双方TTYの場合だけ承認を受け付ける。非TTYのyは許可せず、EOF/Ctrl+Cを規定の終了状態へ分ける               | §5       |
| SES-R09 | memory/handoff/local browserは明示手動操作とし、所有・権限・source/hash/revisionを再検査する。旧モデルツール公開は0 | §6       |
| SES-R10 | report/replayはprovider/runtimeを作らず保存データを読む。会話exportと公式recordレポートを別出典として表示する       | §5〜§6   |
| SES-R11 | 退役した手動改善比較のUI/実行IPCを再提供せず、廃止要求は拒否し既存DB/会話/利用者データを保持する                    | §6       |

承認期限やモデル実行の通信上限は [workflow仕様](../workflow/Spec.md) を正本とし、この文書で別の値を定めない。手動受渡し・ローカル観測の確認期限は会話側の§6で定める。

## 2. 会話と作業場所

会話はID、タイトル、workspaceId、cwd、model/effort、作成・更新時刻等を保存する。workspaceを選んだ新規会話は登録rootを使い、workspace未指定はhome内の会話専用scratchを作る。readOnlyでは作業開始を許可しない。登録作業場所が不明・消失・操作中なら、別の場所へ黙って切り替えない。

既存会話を開くと保存履歴を表示し、閉じる操作は履歴削除と区別する。`delete_session`は会話IDと明示確認を要し、送信準備・実行・worktree操作等との競合を拒否する。削除開始後はその会話の遅延保存・再送を通さない。

Gitの明示的な隔離会話と既存worktreeのkeep/merge/remove/remove_branch/restoreは手動操作である。mergeは記録済み基準ブランチと双方のclean状態を再確認し、競合時はworktreeを残す。通常直列作業の直接編集や、限定parallelのハーネス所有worktreeと混同しない。実行契約は [workflow仕様](../workflow/Spec.md) を参照する。

### IPCの主な入口

型とparserの基準は [shared/ipc.ts](../../src/shared/ipc.ts)。戻り値は`ok`と失敗時の`error`を区別し、失敗を受付済みと表示しない。

| 入口                                    | 対象・意味                                                 |
| --------------------------------------- | ---------------------------------------------------------- |
| `pick_folder` / `new_session`           | 作業場所登録、新しい会話の作成                             |
| `open_session` / `close_session`        | 保存会話の表示と表示終了                                   |
| `send` / `abort`                        | 会話IDを指定した通常入力と停止                             |
| `delete_session`                        | 会話IDと`confirmed`を確認する履歴削除                      |
| model/effort・mode・worktreeの各command | 保存選択や手動作業場所の変更。実行中の条件を暗黙更新しない |

## 3. 保存・起動・再開の状態

通常homeは`~/.xharness`、fakeは`~/.xharness-fake`を使い、`XHARNESS_HOME`で別homeを指定できる。起動処理が正規化したhomeの単一writerを取得する。同じhomeが使用中、所有者が不明、確認権限が不足の場合は起動を拒否する。所有PIDが存在しないと確認できた場合だけstaleロックを回収し、別homeは別writerとして扱う。headlessの読取専用report/replayはモデルruntimeと実行writerを起動せず、保存済みデータのsnapshotを読む。

索引は一時ファイルへの保存・sync後にrenameする。破損索引は退避して警告を残す。会話JSONL等の破断末尾は証拠として残し、新しい追記は独立した行から行う。保存・削除を順序付け、削除済み会話を後着の書込で復活させない。

通常作業は再起動後に自動再送・自動resumeしない。未完了公式recordはinterrupted等の保存状態を示し、pending承認は再発行・再利用しない。旧未完了タスクや未確定保存は新しい公式処理へ引き継がず、記録と作業を保全して理由付き停止する。

`open_session`やheadlessの`--resume`は会話履歴を開く操作であり、モデルのnative threadの再開とは別である。固定課題等の安全checkpoint再開はworkflow側が明示的に適格性を判断する。別モデル選択やalias更新を理由に未確定query・外部副作用を再送しない。

## 4. GUIの表示と操作

### チャットと承認

通常入力の形式・上限、質問/作業の判別、計画契約は [workflow仕様](../workflow/Spec.md) に従い、通常モデルへ旧ハーネスツールを公開しない。画像・旧実行slashは通常入口で拒否し、停止ボタンと`/stop`は使える。

計画、操作、既存permission/plan/rewindの確認をTranscript内に置く。公式計画・操作は保存recordのsessionIdが現在の会話と一致し、workflowIdも一致するときだけ承認カードを表示する。cwd一致やID欠測から会話を推測しない。操作のnative session/thread IDとconversationSessionIdは別項目である。

カードは計画、担当の保存モデル/effort、対象、command、digest、承認UUID、期限、許可/拒否を示す。main側が会話・UUID・digest・期限・取消を再検証し、一度だけ受理する。独立検証のカードは実行program・argv・対象・検証仕様digestを示し、フロー許可へ変更しない。詳細な計画・操作契約はworkflowの仕様が基準である。

### Receiptsと停止理由

通常workflow専用パネルは通常UIに表示しない。接続・SDK情報は設定、承認はチャット、保存済みの詳細はreceiptsに置く。fake/明示verificationの専用パネルは開発確認用に残す。

Receipts全体は既定で開閉行だけを表示し、HTML出力・読取再生・保存詳細は手動で開く。展開状態を保存設定へ書かず、新規会話・会話切替・再起動で閉じ、実行や証跡更新から自動展開しない。公式証跡内部のdetailsも手動開閉する。開閉summaryは見出しと件数だけを示す。保存recordがまだない同会話の接続準備中は、状態文と「接続確認を中断」を内側detailsの外に表示し、内側が閉じていても操作できる。別会話の準備操作を表示せず、取消は元のworkflow IDと現在の会話IDを送る。外側Receiptsの既定折りたたみや自動展開禁止は変えない。

公式receiptsを開くと保存計画、直列/並列の理由・条件、担当モデル/effort、作業領域、検証・レビュー、通信・モデル・スキル証跡、HTMLリンク、取消とresumeBlockedを示す。展開時は全内容をスクロールでき、別会話または会話ID不明のrecordを通常のcurrent会話へ混ぜない。

モデル報告のテストとハーネス独立検証を別表示する。usage、policy/catalog、本文、スキル観測等の欠測は未取得・未保存・未確認と表示し、ゼロや成功へ補完しない。停止時は理由、保全した作業領域、再開不能理由を表示する。保存本文の取得は基盤内部の全往復の復元ではない。

### 通知と設定

通知は新しい承認/入力待ち、終了/停止の遷移を固定文面で知らせる。依頼本文、command、cwd、秘密は通知本文へ含めず、読込済みの旧待機/完了を再通知しない。

`notification_focus {sessionId, workflowId?, approvalId?}`は、存在する会話を開き、対応カードへfocusするためのイベントである。未知・削除済み会話を開かず、クリックで許可・再送しない。カードfocusは同じ通知に対して一度だけ行い、定期取得で操作中のfocusを奪わない。

通知が出ない場合のWindows設定案内は表示するが、OS設定や権限をアプリから変更しない。通知が使えなくてもチャットで確認できる。対象Windowsでの通知の実確認はこの文書の検証範囲外。

## 5. Headless

`src/headless.ts`はGUIと同じSessionController / OfficialWorkflowServiceを使う。headless専用のHTTP・モデルツール・認証fallbackを持たない。

| 種類        | 操作と意味                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------- |
| 新規起動    | `--model`、`--effort`、`--cwd`、`--mode`、`--fake`、`--codex-path`                              |
| 履歴を開く  | `--resume sessionId`。保存cwd/model/modeを保持し、これらの変更指定との併用を拒否                |
| 端末command | `/help`、`/exit`、`/stop`、`/model`、`/mode`、`/resume [id]`、`/clear`、`/history`、`/workflow` |
| 読取専用    | `--report sessionId --output new.html`、`--replay sessionId`。provider/runtimeを初期化しない    |

`/resume`は保存会話の一覧、`/resume id`はその会話を開く。`/clear`は旧履歴を消さず新しい会話を作る。`/history`は選択会話の保存テキストを表示する。`/workflow`は同homeに保存されたworkflowの一覧を明示的に表示する。通常承認は選択会話に結び付け、一覧表示を他会話の実行許可にしない。

計画/操作承認はstdin・stdout双方がTTYの場合だけ行い、プロンプトへの`y`をその要求への許可として使う。非TTYではパイプ中の`y`を含め無断許可せず、記録と変更を保全して停止する。期限切れ・要求撤回は入力待ちを解除する。

非TTYのEOFは入力完了であり、受領済みの質問を処理できる。Ctrl+CやTTY実行中のEOFは取消で、未送信のbufferを新規実行へ渡さない。終了コードは0正常、1拒否/失敗/承認不能、130中断。終了時はcontroller/service/端末を閉じ、home writerを解放する。

旧会話の送信・設定変更は拒否し、読取やreport/replayは保存したモデル設定が現在無効でも閲覧できる。手動memory・handoff・local browserの専用slashは現行help/parserにないため、GUI/IPC対応をheadlessの操作対応と読み替えない。

## 6. 手動管理・レポート・退役境界

| 機能               | IPC・外部振舞い                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| プロジェクトメモリ | `project_memory`: list/add/accept/reject/edit/merge/invalidate/delete。revisionを照合し、候補・採用・却下・失効と出典を保存    |
| 結果受渡し         | `handoffs`: list/preview/confirm/cancel。完了証跡を検証し、60秒のpreviewを明示確認、変更・取消・重複を再確認                   |
| ローカルブラウザー | `local_browser`: view/observe/prepare/confirm/stop。固定ローカルcounter fixtureのみを観測し、prepare後60秒の確認期限で明示操作 |
| HTMLレポート       | GUI `export_report`・headlessは保存会話/レシート/traceを出力。公式receiptsのHTMLリンクは別のworkflow record詳細を開く          |

memory等の適格性は、登録workspace root、homeの実体、SessionStoreの所有home、保存会話を再確認する。非Gitはroot内、Gitは最寄りrepositoryのcommon Git directoryが登録rootと一致する場合に許可する。同じrepositoryのlinked worktreeを、独立nested repositoryと区別する。scratch、忘れたworkspace、別home、別repository、rootのsymlinkは拒否する。

メモリは出典をモデルの主張・利用者の記述・tool結果に区別し、採用をtool成功へ読み替えない。自動system注入、旧履歴再実行、旧モデルツール公開をしない。手動操作時も既存validator・権限検査・readOnly・busy条件を維持する。

受渡しは保存済み公式結果の承認、通信、最終差分レビュー、報告を照合する。限定DAGでは所有manifest・node証拠・独立process結果・必要な統合レビューを別途検証する。現在のsource HEADの再検査と保存完了snapshotの検査を混同しない。body/source hashを固定した参考台帳へ保存し、メッセージを勝手に追加せず、providerを作らず、権限も与えない。

ローカル観測は任意のWebページ、一般のデスクトップ、ログイン済みブラウザーの操作ではない。新しい非永続profileで外部通信、認証profile、download、新window、Node/preloadを遮断する。観測・画像・document・generationと確認期限を照合し、不確定なクリック結果はunknownとして残し、自動再実行しない。

レポートはHTML escapeと秘密・思考等の安全化を行うが、未知の利用者秘密を完全に除去する保証ではない。CLIの出力は新規ファイルのみで、既存レポートを上書きしない。

手動改善版・評価ケース・モデル候補比較のUI/実行IPCは退役し、旧要求は廃止理由で拒否する。既存比較DB、会話、利用者データは保持する。通常のレビュー修正・モデル実績feedbackとは別機能である。

## 7. 受入条件と根拠

| 受入ID  | 判定する振舞い                                                                                               | 直接根拠                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SES-A01 | 同一実体homeの二重writerを拒否し、未知所有者を回収しない                                                     | [home-writer.test](../../src/main/home-writer.test.ts)                                                                                                                                                                                                                                                        |
| SES-A02 | 準備中の削除/worktree操作、削除後の遅延保存を拒否し、履歴を復活させない                                      | [session-boundaries.test](../../src/main/session/session-boundaries.test.ts)、[storage-consistency.test](../../src/main/session/storage-consistency.test.ts)                                                                                                                                                  |
| SES-A03 | 未確定な外部処理を復旧ログから再実行せず破断証跡を残す                                                       | [storage-consistency.test](../../src/main/session/storage-consistency.test.ts)                                                                                                                                                                                                                                |
| SES-A04 | 別会話・欠測会話・期限切れ・二重クリックを許可へ変換しない                                                   | [ChatOfficialApprovals.test](../../src/renderer/components/ChatOfficialApprovals.test.tsx)とworkflow側の承認テスト                                                                                                                                                                                            |
| SES-A05 | receiptsが同会話の保存値を表示し、承認を持たず、既定折りたたみで証跡へ到達でき、準備取消を開閉見出しと分ける | [OfficialWorkflowReceipts.test](../../src/renderer/components/OfficialWorkflowReceipts.test.tsx)、[App.official.test](../../src/renderer/App.official.test.tsx)、[移設検証](../workflow/report/chat-approvals-notifications-20261009.md)、[既定折りたたみ検証](report/receipts-default-collapsed-20261009.md) |
| SES-A06 | 通知は固定文面と既知会話focusだけを使い、旧状態を再通知しない                                                | [notifications.test](../../src/main/notifications.test.ts)、[App.official.test](../../src/renderer/App.official.test.tsx)                                                                                                                                                                                     |
| SES-A07 | 非TTYのyを承認せず、EOF/Ctrl+Cを正しく扱いwriterを解放する                                                   | [headless.test](../../src/headless.test.ts)                                                                                                                                                                                                                                                                   |
| SES-A08 | 手動memoryと受渡しのsource/revision/hashが変われば拒否する                                                   | [project-memory.test](../../src/main/session/project-memory.test.ts)、[handoffs-official.test](../../src/main/session/handoffs-official.test.ts)                                                                                                                                                              |
| SES-A09 | ローカル観測の期限・document置換・取消・再起動・境界を検査する                                               | [computer-use boundaries.test](../../src/main/computer-use/boundaries.test.ts)、[local-browser-electron.test](../../src/main/local-browser-electron.test.ts)                                                                                                                                                  |
| SES-A10 | report/replayをモデル実行なしで読め、既存出力を上書きしない                                                  | [headless.test](../../src/headless.test.ts)、[report.test](../../src/main/session/report.test.ts)                                                                                                                                                                                                             |
| SES-A11 | 旧手動比較要求は拒否し既存DBを保持する                                                                       | [retired-manual-improvements.test](../../src/main/session/retired-manual-improvements.test.ts)                                                                                                                                                                                                                |

これらは実装上の受入判定と対応テストを示す。今回の文書編集ではテストを再実行しておらず、過去テストの成功を最新Windows・GUI・配布・実モデルでの成功へ拡大しない。最新の実測範囲は日付・対象HEAD付きの個別検証記録で確認する。
