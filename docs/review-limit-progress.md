# レビュー既定上限5回への変更（2026-10-04）

- ユーザー承認により `loadAgentConfig` と `WorkflowState` の既定を2回から5回へ変更。初回を含むレビュー合計を数え、5回目でも must / should が残ると attention で停止する。指摘解消時は上限前でも完了する。
- ユーザー／プロジェクトの明示設定（1〜10）を優先する既存動作は維持し、ユーザー設定ファイルは変更していない。DESIGN.md §20.2と§20.4を更新した。
- 設定既定値とmust / shouldの5回目停止の回帰テストを追加。runtimeの既存2回停止テストは明示的に2回を指定して意図を維持した。
- 関連3ファイル82件、typecheck、lint、git diff --checkは成功。後続のローカルリンク修正後、全体テスト140ファイル・1275件も全件成功（並列1、testTimeout=30000）。その後exeを作成・保管した（[配布結果](local-links-release-result.md)）。GUI確認／Node 22互換実行は未実施。この時点では別タスクのローカルリンク対応にshould2件が残っていた。後続の修正・検証結果は [local-links-progress.md](local-links-progress.md) に記録する。

## 検証環境・認証復旧

- Windows / Node.js 24.16.0（`C:\Program Files\nodejs\node.exe`）、ローカルpnpmラッパー `scripts/pnpm.ps1` を使用。
- PowerShell 7.6.6 Store版：`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`。
- 正式レビューはClaude資格情報の期限切れで失敗していた。旧期限は2026-10-04T11:59:56.532Z。保存済みtraceで2026-10-04T12:00:00.052Z以降に `Claude authentication failed`、`dispatched: false`、HTTP statusなしを確認した（API送信前の失敗）。
- ユーザー承認を受け、公式CLI `C:\Users\ahwri\.local\bin\claude.exe` をHaiku・短文・toolsなし・max-turns 1・no-session-persistenceで1試行しexit 0。CLI出力は保存していない。更新後の資格情報期限は2026-10-04T20:07:59.352Z、expired=falseを読み取りで確認。資格情報の書き込みは公式CLIのみで、自前refresh・秘密値出力／保存は行っていない。
- 更新後の正式レビューが実行でき、設計書§20.4の旧既定2の残存がshouldとして指摘されたため5へ修正した。正式再レビューは完了し、must / shouldは0件。出力JSON解析失敗の1回を経て再試行した。
- 当初はnitとして報告のみだったが、ユーザーの追加指示を受け、DESIGN.md §16.9の表示例を `round 0 / 5` へ更新し、docs/phase5-progress.mdの旧既定2は過去記録だと明示して現行仕様の注記を追加した。
