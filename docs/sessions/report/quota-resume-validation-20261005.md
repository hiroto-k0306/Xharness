> 過去の記録：移動元 `docs/quota-resume-validation-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 利用枠再開の検証（2026-10-05）

第3段階のコード・テスト対象は`feat/quota-resume`の`323a6b1`。第2段階`4dfa0f1c55cc50ac5ad6307a7fa76928698c6821`から独立作業領域`C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness`で作業した。GitHub mainは終了前の読み取り確認でも`4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb`。元の`D:/AIwork/Xharness`はHEAD`50e7707c0704e1d5aea5818cdea4bae8a2ef7599`・cleanのまま。push・mergeは行っていない。

## 実装コミット

- `374c67f`: 独立した待機JSON、明示承認、期限/取消、単一claim、再起動と未確定実行の停止。
- `ddc9e15`: 通常会話の安全境界、観測quota、保存履歴と設定・実cwd・HEAD/indexの条件hash。
- `1ffa6cc`: desktopの保存済みタスク続行、前提再確認、終了/中断、主・子の都度許可。
- `d26d58d`: 再開予定UI・コマンド・fakeデモ・headless manual-only案内とGUIテスト。
- `85700b8`: clock/lease/保存故障・未知/週次/共有pool・途中応答/fallbackのmockテスト。
- `323a6b1`: 同一task/prefix、再起動、履歴/設定/指示/HEAD/effort/権限変更、停止、workflow未対応、ツール確認の統合テスト。

## 環境と実行済み

Windows、Node`v22.23.3`、pnpm`10.34.6`、PowerShell`7.6.5`。シェル実体は`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`。ローカル`.tools`と`.\scripts\pnpm.ps1`を使用。依存・lockfile変更なし。AGENTS.md/SPECと既存保存/評価/historyを優先し、DESIGNは歴史資料として扱った。取得mainに`.agents/skills`はない。

| 確認                             | 最終結果                                                    |
| -------------------------------- | ----------------------------------------------------------- |
| `pnpm test`                      | **160ファイル・1529件すべて通過**（201.21秒）               |
| 枠待ち/イベント関連回帰          | 4ファイル・32件通過（最終全回帰にも含む）                   |
| 中断/準備・枠待ちの修正後回帰    | 4ファイル・41件通過（最終全回帰にも含む）                   |
| `pnpm lint`                      | 通過                                                        |
| `pnpm typecheck`                 | 通過                                                        |
| `pnpm test:gui`（build含む）     | **7件すべて通過**（8.5秒）。main/preload/renderer build通過 |
| Prettier全体・`git diff --check` | 通過                                                        |

fake UIは一時home/一時アプリだけを使い、有効化OFF→waiting→cancelled、予定/期限/枠表示・取消後のボタン消去を検証。既存評価レポート/history/起動/同home writer排他/未確定記録の拒否も通過。画像`.out/gui/quota-resume-fake-quota-UI-d758d-d-exposes-opt-in-and-cancel/quota-cancelled.png`を視認し、再開予定欄の可読性と配置を確認した。生成画像はGit管理外で、再実行で作成できる。

## 発見した回帰と修正

最初の全回帰でshutdown中の送信準備3件が失敗した。永続待機のclose保存をawaitする前に、準備/実行のAbortSignalを同期的に止める順序へ直した。修正後の41件と最終全回帰1529件が通過した。最初のUI fixtureでは既定fallbackが発生し、安全条件どおりmanualになった。有効化/取消テストはfallback無効のfake fixtureに調整した。テストの未使用引数とUIの書式も最終確認で修正した。

## 未実行・制約

実Claude/Codex/ChatGPT通信、認証CLI、サブスク枠消費は行っていない。実際のquota回復時刻・実通信による自動再開成功は未確認。Node24、WindowsApps/Store版PowerShell、exe/インストーラーは未検証。

対応はdesktop通常会話offの、停止ターンに途中応答/ツール/fallback/認証更新/有効hookがなく保存確定した境界だけ。workflow途中、headless、外部成功不明、未確定保存、一時的許可、MCP/Web使用済みを自動復元しない。アプリ終了中の実行、全未stage/未追跡ファイルの内容snapshot、アカウント別pool識別はない。不明resetは不明のまま手動確認へ回す。仕様・再実行手順は[枠待ち再開](../../../Old/doc-layout-0e5fa40/docs/quota-resume.md)を参照。
