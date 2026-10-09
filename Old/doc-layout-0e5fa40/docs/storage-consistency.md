# 保存整合性と単一writer（第1段階）

評価基盤`c581d7a`からの追加。現行仕様はSPEC.md §3・§10。履歴検索・自動再開はこの段階に含めない。

## 保存境界と復旧

元の処理ではタスクを閉じてからreceipt・会話を保存していた。完了traceとactive更新、会話、receipt、呼出数は別ファイルなので、停止点によって成功の表示と保存状態が食い違う。また会話／receiptの途中行の後に追記すると、新しい正常行まで壊れた行に連結する場合があった。

実行の開始を評価履歴`<sessionId>.evaluation.jsonl`へ`settled:false`として同期保存する。同じworkflowの続きにも毎回開始を記録する。受理したuser依頼をモデル実行前に保存する。既存のtraceは観測usage・実行根拠を保存し、receipt・会話・呼出数・索引の保存後に`settled:true`で確定する。正常終了・通常の失敗・ユーザー中断でも、保存が全て完了していれば確定できる。activeはタスク未完了、settledは保存の確定を表し、両者を混同しない。

手動圧縮も開始・確定を記録する。未完了IDへの帰属とセッション共通分の区別は維持し、完了IDを新たな実行タスクとして開かない。プロバイダは呼出数の予約を永続化するまでfetchへ進まない。保存失敗を検出した場合は送信しない。

追記ファイルは末尾の改行を確認し、途中行を削除せず別行から新しい記録を保存する。会話・receipt・評価履歴はファイルsyncまで待つ。JsonFileの一時ファイルもsyncしてからrenameする。ReceiptStoreの読取は同じIDの再配信を重複させない。既存形式に任意のsettledを追加し、旧会話や旧評価記録は保持する。

再起動時は保存済みセッションに対して評価履歴とtraceを読むだけで照合する。未確定の実行に終了traceがあればactiveを修正できるが、保存済みとは扱わない。モデル・Bash・ツール・外部APIを再実行しない。欠けたusage・receipt・会話を成功や0に補わない。未確定な会話のモデル実行・圧縮は拒否し、HTMLレポートに「保存未確定」と表示する。新しいセッションは使用できる。旧評価履歴でも終了spanのない実行を検出できれば同じ停止扱いにする。

## home単位のwriter

desktopと通常のheadless起動は、他の保存処理より前に実体パスを正規化したhomeの`.writer-lock`ディレクトリを排他的に作成し、PIDとランダムな所有tokenを同期保存する。既存Electron single-instanceは維持する。明示的なfake homeはElectron userDataも分離するため、別homeは独立したfake環境として同時起動できる（配布形態によらない）。

既存ロックの所有PIDにsignal 0で生存確認し、ESRCHの場合だけstale回収する。PID再利用は生存扱い、EPERM・不正／途中のowner・確認不能は拒否。回収は`.writer-lock.recovery`の排他的ガードで直列化し、競合した取得者は新しい所有者を削除しない。アプリやユーザーのプロセスをkillしない。desktopはプロセス終了まで保持し、shutdownのタイムアウト後にまだ書込みが走る可能性があるため途中で解放しない。headlessは終了処理完了後に自分のtokenを確認して解放する。report/replayの読み取り専用CLIはwriterを取得しない。

ownerが未作成・破損、または回収ガードが残った場合は自動解除しない。所有アプリが存在しないことを利用者が確認してから、記録を退避してロックを手動で点検する。時間経過だけを理由に解除しない。

## 制約

これは複数ファイルのACIDトランザクションや外部サービスのexactly-once保証ではない。保存不確定時は再実行を止めることで二重副作用を防ぐ。workflow段階・子プロセスの復元、未確定な会話をそのまま安全に続ける手順は後続段階。保存が確定した通常会話の振る舞いは維持する。

traceは従来どおり容量上限・ローテーション・任意の保存失敗があり、取得されていないusageは復元できない。旧記録はsettledを持たないため、全ての過去のファイル間不整合を判定できるわけではない。壊れたindexからセッションmetadataを推測して作り直さない。ファイルsyncとrenameでプロセス停止への耐性を高めるが、ディスク／電源喪失やネットワークFSの完全耐久性までは保証しない。手動編集、独自スクリプト、他の非協調プロセスはhomeロックに従わないため対象外。

## offlineで再実行

WindowsではローカルNode/pnpmのPATHを設定し、以下を使用する。テストは専用の一時homeだけを作り、本物のユーザーデータや既存アプリを操作しない。

```powershell
.\scripts\pnpm.ps1 test src/main/home-writer.test.ts src/main/session/storage-consistency.test.ts src/main/fake-profile.test.ts
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 build
.\scripts\pnpm.ps1 exec playwright test test/gui/storage-safety.spec.ts test/gui/evaluation.spec.ts test/gui/smoke.spec.ts
```

fault injectionはreceipt、会話、確定記録、確定記録の途中行、呼出数rename失敗を再現する。mockの外部副作用後に例外を出し、復旧で再実行されないことも検査する。ロック試験は同じ実体home、別home、生存PID、PID再利用、権限不足、不明owner、stale回収競合。GUIはdesktop→同home headless拒否、別home fake同時起動、未確定会話の実行拒否とレポート表示を確認する。
