# 確定結果の受け渡し（第5項）

基点は `29bf0c0`、専用ブランチは `feature/task-handoff`。現行仕様は [SPEC.md](../SPEC.md) §10。これは最新の確定済み・完了タスクの最終回答本文1件を、同じworkspace/projectの別会話へ渡す機能。任意の双方向会話、エージェントの自律対話、自動送信・実行・再開は対応していない。

## 操作

projectの会話で「結果の受け渡し」を開き、宛先を選んで「送信プレビュー」。出典session/task、完了日時、宛先、本文とhashを確認し、checkboxの後「明示送信」。確認票は60秒で失効する。宛先選択の変更、取消、閉じる、renderer再読込、アプリ再起動で未送信確認票を失効させる。

宛先の同じ画面で「送信・受信一覧を再取得」。受信日時と出典を持つ未信頼のsnapshotを表示する。「参照と出典をコピー」で通常入力へ貼り付け、新しい依頼を利用者が別途送信できる。受信自体はモデル呼出でも客観テスト合格でもない。通常の宛先側権限・予算・許可確認を通る。元のsystem、権限、認証、ツール、画像、隠れた推論、任意metadataは移植しない。本文は既存historyTextと既知秘密のredactを使う。秘匿行の検出はヒューリスティックなので、利用者もプレビューを確認する。

## headless（モデルを呼ばないローカルCLI）

desktopを閉じて同じhomeのwriterを解放する。WindowsではローカルNode/pnpmのPATHを用い `pnpm` を `.\scripts\pnpm.ps1` に読み替える。

```powershell
.\scripts\pnpm.ps1 handoff --home <home> --session <source-session> --destination <destination-session>
.\scripts\pnpm.ps1 handoff --home <home> --session <destination-session> --list
```

送信CLIは本文・出典・宛先を表示して、同一プロセス内で `SEND <表示された確認票ID>` の完全一致を要求する。別入力・EOFは未送信。非対話の自動確認flagはない。`--list`は参照と配送receiptをJSON表示する。CLIはproviderや認証CLIを起動せず、モデル実行への入口を持たない。既存home writerとproject登録・readOnly/plan/write denyを確認する。

## 保存と整合性

2026-10-08の公式接続対応: 通常入力は旧評価task/traceを作らないため、従来の判定では完了していても拒否していた。公式接続の結果は、最新のOfficialWorkflow receiptと同じsessionのworkflow.json、最終user入力・assistant公開回答を照合する。質問の確定回答と、承認・最終HEADの独立テスト成功・レビューまで完了した作業が対象。判別だけで対象確認待ちの作業、失敗、取消、実行中、保存欠落、不一致は拒否する。旧履歴へmetadataを一括追加せず、既存のreceipt・workflow・本文が一致するものも確認できる。詳しい検証は [公式結果の受け渡し修正](official-result-handoff-20261008.md)。

homeの `handoffs.json` は1レコードが送信receiptと宛先の永続受信を兼ねるatomic台帳。送信時snapshot、両sessionの作成時刻/cwd、project実体、task ID、本文hash、source history/trace hash、完了/受信日時を保持する。既存JsonFileのsync→renameとhome writerを再利用する。会話・評価・trace・既存receipt JSONLへ別々に追記しないため、「送信成功だけ保存、受信欠落」の途中状態を作らない。台帳の受信確定が成功の根拠であり、既存モデル実行receiptとは別の記録として画面に表示する。

送信時に現在の登録・project実体・両会話のidle・権限・最新のsettled/active・完了trace・本文を再確認する。本文またはtrace変更、巻き戻し、欠落、未確定、別タスク、完了後の手動圧縮は拒否。確認中のsource/destination削除・権限変更・project解除・モデル実行はsession leaseで拒否する。同じsnapshot/task/宛先の再プレビューや二重クリックは1受信だけ。返信を失っても同じdelivery IDの再確認や受信一覧で確認できる。未送信確認票は再起動で消え、確定受信は残る。

source削除後も確認済み受信snapshotを保ち、出典参照不可を明示する。宛先削除・project/cwd変更では受信を現在の会話に表示しない。台帳は監査・重複防止のため保持し、新しい会話へ移し替えない。正常なアプリ内変更ではproject実体と作成時刻も照合する。外部でprojectを無断変更した場合は境界を満たすまで非表示になる。

保存前の取消・障害は未受信。atomic書込み開始をcommit境界とし、その後の取消は受信を撤回しない。書込み・応答の異常では成功と表示せず、一覧再取得を案内する。保存後に応答を失ったケースも受信IDで重複を防ぐ。壊れた台帳は何度読んでも送信を止め、空台帳に置換して再送しない。

home全体100受信・2,000,000 UTF-8 bytes、最終本文16,000文字、保存history読取1MiB、確認票100件の上限。上限では削除や切り詰めによる重複防止情報の喪失を避け、送信を止める。容量整理・delivery撤回・既存実行への自動引用は今後の候補。既存history/trace読取制約と非協調の外部書込み、電源喪失の完全耐久性は保証しない。missing usageや客観品質を補完しない。

## 再実行と次の最小単位

```powershell
.\scripts\pnpm.ps1 test src/main/session/handoffs.test.ts src/main/session/handoffs-cli.test.ts
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 test:gui
```

試験は専用一時home/project、FakeProvider、mock readline/storageを使用。実Claude/Codex通信・認証CLI・サブスク枠・Computer Useは使わない。

第6項の隔離ブラウザは、まずfake transportの固定ページ観測→利用者が1操作を確認→操作結果receipt→停止の一往復に絞る。専用の一時profileを用い、ユーザーのCookie/ログイン/拡張/既存ブラウザへ接続しない。許可したoriginと操作対象を確認票に固定し、DOM変更・期限・取消・再読込で失効。network、download/upload、ファイル、clipboardは初期deny。受け取ったページ本文は未信頼参照でありsystemや権限を変更しない。主処理から分離したプロセスでtimeout・終了・receipt欠落をfake検証する。実ブラウザやComputer Use接続は、この境界を確認した次段階の明示依頼で扱う。
