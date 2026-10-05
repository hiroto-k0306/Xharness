# 利用枠回復後の安全な再開

第3段階の最小対応はdesktopの通常会話（`workflow.mode: off`）で、モデル応答・ツール実行前に枠制限で停止し、履歴保存が確定した境界。自動選択・認証方式・履歴検索の権限は変更しない。既定OFFであり、待機の記録だけではモデルを呼ばない。

## 利用手順

1. 通常の429再試行・既存fallbackの後、`rate_limited`で止まった会話に再開予定欄が出る。
2. 理由・provider/model・タスクID・段階・枠の種類・次回確認・期限・試行数を確認し、「条件を再確認して自動再開を有効化」を選ぶ。対象の会話だけに効く。
3. アプリを起動している間、予定後に安全条件を再確認して続行する。時刻到達は回復の保証ではなく、まだ429なら新しい観測に基づいて待機を更新する。
4. 回復時刻不明で安全な境界の場合だけ「今、条件を再確認して続行」を選べる。復元できない境界は新しい指示・会話とレポートで手動確認する。

`/quota-resume enable|cancel|now`でも操作できる。nowも前提チェック・現在の通信上限・権限を通り、無条件のprompt再送はしない。モデル通信を伴い得る操作としてUIに続行と表示する。新しいuserメッセージは追加しない。途中の応答を補完したり、未確定ツールを再実行したりしない。

取消・明示停止・閉じる・新しいモデル依頼・削除で解除。モデル/effort/権限変更は次の前提チェックで停止する。期限は元停止から14日、自動続行は最大3回で、継続した枠待ちにも元の期限・回数を引き継ぐ。

## 保存と判断

ホームの`quota-pauses.json`（最大100会話）に停止状態・観測時刻/Retry-After/scope/windows・予定・取消/期限・承認時刻・試行数とsnapshotを保存する。snapshotは元依頼の履歴位置、評価taskId、段階、未完了の最後の依頼、provider/model/effort、system/tools前提hash、会話と圧縮checkpointのhash、実cwd/workspace/worktree/HEAD/ref/indexと設定・指示・権限・信頼・catalogの条件hash、直近receipt参照を持つ。秘密・元prompt・system/tools本文・資格情報は複製しない。実際の依頼・試行結果は既存会話/receipt/traceを同じtaskIdで追跡する。既存保存形式は維持し、待機は独立ファイルに置く。

最新の失敗試行だけの枠情報を使う。明示scopeまたはwindow durationで5h/7dを識別し、識別できなければprovider-pool-unknown。枯渇windowのresetが一つでも欠ければ不明とし、固定5時間を足さない。既知resetとRetry-Afterの遅い方を採用する。同providerの別待機も共有poolと保守的に扱い、遅い既知resetまで待つ。不明peerがあれば自動確認を止め、不要なpeer待機を取消した上で手動確認する。アカウント別のpool分離は未対応。トークン量・API換算費用からサブスク枠を推定しない。

既存home single-writer（desktop/headlessの排他）に加え、claimを同期保存してから単一leaseを取得し続行する。並行tickはrunningを見て二重起動しない。取消と期限はAbortSignalで実行/承認待ちを中断する。プロセス終了中のrunningはmanualとなり再送しない。保存済みwaitingだけを再起動時に復元する。OSサービス・アプリ終了中のtimerはない。壊れた待機JSONは既存JsonFileのbackupと警告を使い、安全な空一覧へ戻す。

再開はfresh runtimeを組み、同じ保存履歴と評価taskIdを使用する。通信直前にも実効system/toolsの既存照合と条件hashの再確認を通す。再開後の主・子のtool permissionは都度確認（今回のみ）にし、deny/readOnlyを維持する。通信回数の上限も既存の送信前保存・判定を使う。

## 自動対応しない状態と制約

- workflow途中（consult/plan/implement/review）、ツール呼出/結果・途中text・fallback・認証更新・有効hookがあった停止ターン。401/403、権限待ち、明示停止は枠待ちとして扱わない。
- 保存未確定、旧会話の前提不明、一時的な信頼/許可、接続MCP、Web使用済みのruntime。外部操作の成功を推測しない。
- headlessの自動再開。rate_limited停止時にmanual-onlyを表示する。既存の手動`/resume`と別であり、desktopの待機timerをheadlessは復元しない。
- `/schedule`は起動中だけの予約で、rate limit等の異常停止で取り消す従来仕様のまま。この永続的な枠待ちとは別。

HEAD/ref/index・登録root・指示/設定を照合するが、全ての未追跡/未stageファイルの内容snapshotや悪意ある保存先改ざんの検出は提供しない。そのため、同じ停止ターンで既にファイルを読んだ/操作した状態は対象外とし、復元後はRead-before-Writeと現在の権限確認を使う。アカウント切替を永続的に識別するIDは保存しない。利用枠や残量の正しさは実プロバイダ通信で今回確認していない。

## オフライン再実行

```powershell
.\scripts\pnpm.ps1 test src/main/session/quota-pause.test.ts src/main/session/quota-resume.test.ts src/main/session/quota-events.test.ts
.\scripts\pnpm.ps1 test
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 test:gui
```

fake UIデモは隔離homeで`workflow: {mode: off}`と`fallback: {claude: null, codex: null}`を設定し、新規会話に`quota-demo`を送る。120秒・5hのfake待機で、既定OFF→有効化→取消を確認できる。復元/続行・週次/不明・前提変更・保存故障はmock clockとFakeProvider scriptで検証し、実CLI・認証・プロバイダ・サブスク枠を使わない。検証記録: [2026-10-05](quota-resume-validation-20261005.md)。
