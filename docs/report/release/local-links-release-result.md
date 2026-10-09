> 過去の記録：移動元 `docs/local-links-release-result.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# ローカルリンク・レビュー既定5回の配布物作成（2026-10-04）

## 対象とmain統合

- 確認付きローカルファイルリンクと、その正式レビューで残った表示保護の修正、レビュー上限の既定5回（初回含む）、UIモックと文書の表記修正を含む。
- 開始時点は `main` / `d29a9c8`。ローカルリンク実装のworkerコミット3件（455480d / 35312a2 / d29a9c8）は既にmainへ統合済みだったため、追加のブランチマージは不要。残るレビュー修正も `a61d9a7`（画像内リンク保護）と `90d1d18`（レビュー既定5回・表記）としてmainへコミットした。
- ユーザーはインストーラー作成とマージを承認。remoteへのpushは行わない。

## 作成・保管

- `scripts/pnpm.ps1 package` 成功。アイコン生成 → electron-vite build → electron-builderのNSIS / portableを作成した。
- バージョンは既存の0.0.0を維持。インストーラー／portableとも未署名（Authenticode: NotSigned）。SmartScreen警告が出る可能性がある。
- `scripts/pnpm.ps1 release:collect -- --out D:\AIwork\XHarness-release\20261004-local-links-review5` 成功。既存の保管済み配布物を上書きせず、リポジトリ外へ保存した。
- 保存先: `D:\AIwork\XHarness-release\20261004-local-links-review5\XHarness-0.0.0\`
- 配布物: インストーラー、portable、利用者向けREADME.md、SHA256SUMS.txt。

| ファイル                    |  バイト数 | SHA-256                                                            |
| --------------------------- | --------: | ------------------------------------------------------------------ |
| XHarness-Setup-0.0.0.exe    | 114556176 | `23865174b633d6d67f5017f82f0d172ae6ad26d63e65d3fe83380b363fc0565e` |
| XHarness-0.0.0-portable.exe | 114339488 | `9dd2b09660466da7f97a33eff4654518d2404cb47bc8c8ad940766df639bc0c7` |

## 検証

- 配布先のexe2件とREADMEについて、SHA256SUMS.txtの値との一致を再計算して確認した。
- `dist/win-unpacked/resources/app.asar` のmain／renderer bundleが、今回の `out/` のビルド結果とバイト単位で一致した。
- asar内に `.credentials.json` / `auth.json` / `.env` に該当するファイルが含まれないことを確認した。最初の検査はWindows用asarパスの区切り違いで失敗し、Windows区切りで再実行して成功した。
- 直前の修正検証: 全体140ファイル・1275件すべて成功（並列1、testTimeout=30000）。TextLinks48件、typecheck、lint、build、差分チェックも成功。詳細は [local-links-progress.md](../local-links-progress.md)、[review-limit-progress.md](../review-limit-progress.md)。実装の正式レビューはmust / should 0件、最後のモック1行修正は指摘0件で完了済み。
- package時の警告: package.jsonのauthor未指定、依存の重複参照。ビルドはexit 0で完了。Appテストの既存React重複key警告も残る。

## 環境

- Windows、Node.js 24.16.0: `C:\Program Files\nodejs\node.exe`
- PowerShell 7.6.6 Store版: `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`
- ローカルpnpm 10.34.6（scripts/pnpm.ps1）、electron-builder 26.15.3、Electron 44.5.1、Windows x64。

## 未実施

- 作成したインストーラーによる実インストール、配布exeのGUI起動、ネイティブ確認画面と既定アプリ／Explorer起動は未検証。検証時に既存XHarnessのウィンドウが起動中だったため、既存アプリを終了・入れ替えての試験は行わなかった。
- Node 22互換実行、実際のUNC／ネットワークドライブによる確認は未実施。
- この配布作業では新規API疎通試験や資格情報更新を行っていない。資格情報は配布物へコピーしない。

## nit修正を含む再作成（2026-10-04）

- ユーザーの指示により、最新のリンク保護・性能・memoテスト修正を含めてインストーラーを再作成した。今回のコミットと `origin/main` へのpushもユーザー承認済み。上の「pushは行わない」は前回作業の記録であり、今回には適用しない。
- `scripts/pnpm.ps1 package` 成功。NSIS / portableとも0.0.0を維持し、未署名（Authenticode: NotSigned）。既存の保管済み配布物は上書きしていない。
- `scripts/pnpm.ps1 release:collect -- --out D:\AIwork\XHarness-release\20261004-local-links-nits` 成功。
- 保存先: `D:\AIwork\XHarness-release\20261004-local-links-nits\XHarness-0.0.0\`。インストーラー、portable、利用者向けREADME、SHA256SUMS.txtを保存した。exeはGitへ含めない。

| ファイル                    |  バイト数 | SHA-256                                                            |
| --------------------------- | --------: | ------------------------------------------------------------------ |
| XHarness-Setup-0.0.0.exe    | 114557162 | `bea0aca0175645385f5649a6bb7606c676f3e4c80601c0381cf98e9c770f3a32` |
| XHarness-0.0.0-portable.exe | 114340569 | `29c6feb39b154b0fa666985fb16bab07ee2600f5f107bbd5e63fe16071da4605` |

- SHA256SUMS.txtの3件（exe2件とREADME）を再計算し、全件一致した。asar内の `out/` 全16ファイルがビルド結果とバイト単位で一致。全2884エントリで `.credentials.json` / `auth.json` / `.env` 系 / `.tools` / `.git` の非同梱を確認した。
- asar検査の初回はpnpmラッパー経由のinlineコードの引用符処理で失敗、次は推移依存 `@electron/asar` のトップレベル解決で失敗した。直接Nodeを起動し、既存のpnpm格納先のasarを使って再実行すると成功した。依存追加や設定変更は行っていない。
- package / collect実行Nodeは **22.23.3** (`D:\AIwork\Xharness\.tools\node_modules\node\bin\node.exe`)。asar検査はNode **24.16.0** (`C:\Program Files\nodejs\node.exe`)。PowerShellは **7.6.6 Store版** (`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`)。electron-builder 26.15.3 / Electron 44.5.1 / Windows x64。
- 直前のコード検証はTextLinks105件（Node24 / 22）、全体140ファイル・1332件成功（Node22、並列1・30秒）。typecheck・lint・build・整形・diffチェック成功、追加nitの正式レビューも指摘0件。詳細は [local-links-progress.md](../local-links-progress.md)。今回のpackageでもauthor未指定・依存の重複参照の警告が出たが、exit 0で完了した。
- 実インストール・新規配布exeのGUI起動・ネイティブ確認／既定アプリ／Explorer起動は今回も未実施。既定並列条件のテスト不安定性は未解消。新規実API通信・資格情報操作は行っていない。
