# 統合配布の検証記録（2026-10-04 UTC）

ユーザー承認済みの未コミット変更をすべて統合し、Windows 配布物を作成した。作業ブランチは `release/20261004-integrated`、開始時の `main` / `origin/main` は `a76c937`。既存の worker ブランチと起動中アプリは変更しない。

## 対象

- [ファイル案内の共通仕様と既存会話互換](file-link-guidance.md)。子の JSON 等の構造化報告と相対 `file` フィールドを保持し、手動 compact の版別フォールバックも検証する。
- [Codex ストリームの過負荷分類と復旧表示](codex-stream-recovery.md)。実測済み type / code のみ再試行し、失敗試行の未確定表示を破棄する。
- [開発版 Fake GUI テスト基盤](gui-testing.md)。Playwright、一時ホームと Electron プロファイルの隔離、終了処理。安全設定・実版の保存先は変更しない。
- 通常の `pnpm test` を `--maxWorkers=1 --testTimeout=30000` に変更。旧既定の並列実行で PowerShell / Git 系のタイムアウトが再発したため。並列実行そのものの安定化を意味しない。

## 使用環境

| 対象                    | 版・実体                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 基準 Node               | 24.16.0 / `C:\Program Files\nodejs\node.exe`                                                                           |
| ローカル pnpm 内の Node | 22.23.3 / `D:\AIwork\Xharness\.tools\node_modules\node\bin\node.exe`                                                   |
| pnpm                    | 10.34.6 / `.tools\node_modules\.bin\pnpm.cmd`（`scripts/pnpm.ps1` 経由）                                               |
| PowerShell              | Store / WindowsApps 版 7.6.6 / `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe` |
| Electron / Playwright   | 44.5.1 / 1.63.0                                                                                                        |

## 統合後の確認

| 確認                                         | 結果                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Node 24.16.0 全体テスト（直列・30秒制限）    | 145ファイル / 1417件成功                                                                                        |
| Node 22.23.3 関連テスト                      | 9ファイル / 213件成功                                                                                           |
| 既定変更後の通常 `pnpm test`（Node 22.23.3） | 145ファイル / 1417件成功、exit 0、198.90秒                                                                      |
| typecheck / lint                             | 成功。既定変更後にも再確認                                                                                      |
| electron-vite build / Fake GUI               | 成功 / 2ケース成功                                                                                              |
| `pnpm package`                               | NSIS インストーラー・portable 作成成功、版 0.0.0                                                                |
| `git diff --check` / 変更対象の Prettier     | 成功（既存設定の除外対象 DESIGN.md / lockfile は除く）                                                          |
| 配布物の検証                                 | ASAR 内の out 配下16ファイルが現在のビルド出力とバイト一致。GUI テスト・Playwright・資格情報・`.out` の混入なし |
| `release:collect` / SHA256                   | リポジトリ外へ収集成功。exe のコピー元・先が一致し、マニフェストの全3ファイルも一致                             |

GUI 終了後の新規プロセス・一時ホームの残存は 0。既存アプリは維持した。初期表示と LoopFlow の保存画像も読取確認した。製品の実 API への試験送信・実資格情報の読取・更新は行っていない。

先行の別モデルレビューでは新たな必須修正はなかった。ただしレビュー側の旧既定の並列テストは 7ファイル / 8件失敗した（7件タイムアウト、1件完了待ち assertion）。その後に既定を変更し、上記の通常テスト成功を確認した。レビュー側が実行できなかった Git 差分・新規ファイルの網羅照合は親側で完了した（全36ファイルのステージ差分を読取確認、未ステージ・未追跡の漏れなし、秘密情報・保護パスの混入なし）。追補レビューの README の並列指定例に関する nit も直列の既定へ合わせた。

## 成果物

既存版を上書きせず、[配布フォルダー](file:///D:/AIwork/XHarness-release/20261004-integrated/XHarness-0.0.0/) へ収集した。

- [インストーラー](file:///D:/AIwork/XHarness-release/20261004-integrated/XHarness-0.0.0/XHarness-Setup-0.0.0.exe): 114,558,656 bytes。
- [portable 版](file:///D:/AIwork/XHarness-release/20261004-integrated/XHarness-0.0.0/XHarness-0.0.0-portable.exe): 114,341,968 bytes。
- [利用者向け README](file:///D:/AIwork/XHarness-release/20261004-integrated/XHarness-0.0.0/README.md)、[SHA256SUMS.txt](file:///D:/AIwork/XHarness-release/20261004-integrated/XHarness-0.0.0/SHA256SUMS.txt)。

```text
f7498f59be9a64b52358d6e92f62ba019d308f14c7e2d8b4c8f0e457795c1329  XHarness-Setup-0.0.0.exe
d92d471117567a544d45ce0412014eb709a1755a18a8c75d3cc907f79098f5ee  XHarness-0.0.0-portable.exe
```

exe はどちらも Authenticode `NotSigned`。配布物・GUI 画像・開発環境はコミットしない。

## 既知の警告・未確認

- 全体の `format:check` は未変更の `docs/h3-job-investigation.md`、`docs/h4-review-progress.md`、`docs/m-codex-image-local-check.md`、`docs/release-all-progress.md` の4件で失敗。無関係な整形差分は追加しない。
- AskUserQuestion テストの既存 React 重複 key 警告は未対応。
- インストーラーのインストール・アンインストール試験、今回の配布 exe の起動試験は未実施。Fake GUI は未パッケージ版の試験であり、配布版の起動確認とは扱わない。
- 実 GUI でのローカルリンクのクリック・ネイティブ確認・ファイル起動、実モデルの書式遵守、実サービス混雑中の再試行復旧は未実施。
- 起動中アプリへの自動反映・強制再起動は行わない。更新後の新規会話で共通生成指示が有効になり、版なし既存会話の system 前提は維持する。

各機能文書の配布未実施という記載は、その個別作業時点の履歴。本統合作業で配布物を再生成したが、インストール・配布版起動の未確認は残る。コミット・push・main への統合結果は作業完了報告で確認する。
