> 過去の記録：移動元 `docs/task-evaluation-validation-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 品質・使用量評価の検証記録（2026-10-05）

コード対象: `feat/task-evaluation` の `2ac883e`。基準は GitHub main `4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb`。最新 main を独立 clone し、原作業領域のチェックアウト・未コミット状態を変更しなかった。

## 環境

- Windows、Node.js `v22.23.3`（ユーザー環境の `.tools/node_modules/node/bin/node.exe` を独立cloneの `.tools/node_modules/.bin/node.exe` へコピー）。Node 24は今回未検証。
- pnpm `10.34.6`。`.\scripts\pnpm.ps1` を使用。依存は既存インストールから独立コピーし、junctionとlauncherを新しい領域へ向けた。新しい依存追加・lockfile変更はない。
- PowerShell `7.6.5`、実体 `C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`（Codex同梱）。ユーザーのWindowsApps/Store版pwshでの再検証は未実行。
- `rg`はPATH上になく、PowerShell/Nodeによるファイル検索を使用。
- `.agents/skills` は取得したmain・元作業領域のどちらにもなかった。`AGENTS.md`、`SPEC.md`、既存試験を確認。DESIGN.mdは現行要件として採用しなかった。

## 実行済み

| 検証                                                                                                      | 結果                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `pnpm test` 最終全回帰                                                                                    | **153ファイル・1466テスト成功**。直列、各30秒上限、165.72秒                                                      |
| 関連再検証（provider stream、trace store、workflow、replay、renderer report）                             | 7ファイル・111テスト成功                                                                                         |
| 評価・provider usage・offline fixture・trace・wave checks                                                 | 5ファイル・19テスト成功                                                                                          |
| `pnpm typecheck`                                                                                          | 成功                                                                                                             |
| `pnpm lint`                                                                                               | 成功                                                                                                             |
| `pnpm build`                                                                                              | main・preload・renderer成功                                                                                      |
| `pnpm evaluation:offline .out/evaluation-20261005`                                                        | 3課題×2構成成功。reference 3件合格、操作を省いた3件はoracle不合格                                                |
| `pnpm evaluation:compare .out/evaluation-20261005/manifest.json .out/evaluation-comparison-20261005.html` | 成功。記録読取のみ                                                                                               |
| 隔離 `--fake` GUI                                                                                         | startup / scratch ping-pong 2件成功。評価レポート出力テスト1件成功                                               |
| GUI出力の確認                                                                                             | 評価見出し、完了、模擬呼出、usageカバー率、実fetch送信0、traceリンク、横はみ出しなし。スクリーンショット目視確認 |
| `git diff --check`                                                                                        | 成功                                                                                                             |

評価のテストはOpenAIのcache/reasoningの内数、Anthropicのcache別建て・iterations、明示0と欠測、親子と失敗試行の非重複集計、再開を含むtask ID、稼働/経過時間、モデルレビューとコマンド根拠の区別、trace本文容量省略後のusage保持、課題難度別比較、旧記録を推測で補完しないことを検査した。

## 途中の失敗と対応

初回のsandbox内ではtsxの`uv_os_get_passwd`とesbuildの親ディレクトリ読取によりheadless/ビルド検証が失敗した。ローカルの許可された通常環境で再実行し成功。これは実プロバイダ通信の許可ではなく、fake/mockとビルドのみの実行。

最初の全回帰は1466件中2件不一致: タスクカード追加によるcontextカードの順番、歴史fixtureの`D:/AIwork/Xharness/...`絶対パスが独立clone外になる問題。contextはSTEP名で選択し、旧Read記録の比較には明示読取ルールを使うようテストを修正。fixtureと権限制御自体は変更しなかった。最終全回帰で両方成功。

評価GUIテストでは、scripted FakeProviderと異なり通常のpingがSSE fixtureを再生し完全usageを持つため、期待カバー率を`1/1`へ修正して成功。模擬・実fetch送信0の確認を維持した。オフラインCLIの新規出力先の親ディレクトリ作成も補正して再実行成功。

## 未実行・制約

実Claude / Codex / ChatGPT通信、認証CLI、サブスク枠を消費するアプリ内試験は**実行していない**。実モデルの品質・速度・効率差をこのfixture試験から断定しない。exe・インストーラー作成、WindowsApps版pwsh、Node 24での試験は未実行。

アプリ再起動を越えたworkflow task ID継承、手動圧縮のtask帰属、認証更新CLI内部のusage、サブスク枠のtask帰属、API換算費用は未実装。旧記録に新しい境界を推測で付けず、未関連・欠測を表示する。ライブ評価UIは追加せず、既存HTMLレポートと比較HTMLを使う。詳細: [仕様・再実行手順](../../../Old/doc-layout-0e5fa40/docs/task-evaluation.md)。

元作業領域 `D:/AIwork/Xharness` は、開始・終了とも `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`、`git status --porcelain`出力なしを確認。push・mergeは実行しない。
