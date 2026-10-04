# should 指摘のレビュー修正ループ対応

2026-10-04 ユーザー承認・実装。

- `WorkflowState.reviewed` は must / should のどちらかがあれば implement へ戻す。設定済みのレビュー回数上限に達した場合は attention で停止する。
- RequestReview の修正指示・上限到達時の報告指示も must / should 両方を対象にした。nit は自動修正せず完了時に報告する。ツール集合・system・回数上限は変更しない。
- DESIGN.md §20.4 / §21 を更新。既存の未コミット変更は保持。以前の圧縮・fallback等のレビュー指摘そのものの修正は本変更の対象外。

## 検証

- `scripts/pnpm.ps1 test src/main/workflow --maxWorkers=1`: 7ファイル・78テスト成功。must / should それぞれのループ・上限停止、should 修正後に nit のみで完了する経路を確認。
- 初回の追加結合テストは、既存ファイルを Read せず Write したため失敗。テスト手順に Read を追加して再実行成功（実装の Read 必須制約は変更なし）。
- typecheck / lint / build / git diff --check: 成功。
- state.ts / state.test.ts の Prettier確認: 成功。
- Node v24.16.0: `C:\Program Files\nodejs\node.exe`
- PowerShell 7.6.6 (Store / WindowsApps): `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`

## レビュー実行の障害

初回 RequestReview を2回実行したが、いずれも `Unexpected non-whitespace character after JSON` のパースエラーで失敗。Task による代替レビューも `Unknown agent or invalid Task` で起動できなかった。その後の RequestReview 再試行は成功し、通知文言の should 1件、段階表とレビュー側のテスト未再現の nit 2件を受領した。

## レビュー指摘への対応（2026-10-04）

ユーザー指示により今回は nit まで対応（通常の nit 自動修正方針は変更なし）。

- 完了・上限通知を「修正対象（must / should）」に統一し、通知テストを must / should 両方で確認。
- DESIGN.md §20.1 の review 段階表も must / should と回数上限にそろえた。
- レビュー側の `pnpm test` 未再現について: この Windows 環境ではグローバル pnpm を前提にせず、AGENTS.md 指定のローカルラッパーを使う。再現コマンドは `.\scripts\pnpm.ps1 test src/main/workflow src/main/session/workflow-factory.test.ts --maxWorkers=1`。同コマンドを実装側で再実行し、8ファイル・81テスト成功。typecheck / lint / build / git diff --check も再実行成功。これは実装側の結果であり、レビュー側での再実行成功とは区別する。レビューモデルも検証時は同じラッパーを使用すること。

## 未確認

全体テストの再実行、実APIでの修正ループ、exe の再作成・起動確認は未実施。現在起動中のアプリへは反映されていない。
