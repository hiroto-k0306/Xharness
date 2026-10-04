# 全修正の配布準備（2026-10-04）

## 対象と承認

- ユーザー承認により、開始時の未コミット変更をすべて対象にする。作業ブランチは `release/all-fixes-20261004`、開始時の基点は `bb3de8c`。
- Codex の長いターン内の圧縮、must / should のレビュー修正ループ、制限時のレビューモデル fallback、使用量の最終取得値保持、会話・レシートのスクロール追従、停止ボタン、Windows のローカル pnpm ラッパー、関連テスト・仕様・記録を含む。
- 既存の配布フォルダを上書きせず、exe はリポジトリ外へ収集する。実 API 通信・資格情報の読み取りや更新・既存アプリの強制終了は行っていない。

## 実行環境

- Node.js 24.16.0: `C:\Program Files\nodejs\node.exe`
- PowerShell 7.6.6（WindowsApps / Store 版）: `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`
- pnpm 10.34.6: `.tools\node_modules\.bin\pnpm.cmd` を `scripts/pnpm.ps1` 経由で利用。

## 検証

- `./scripts/pnpm.ps1 test --maxWorkers=1`: 136 ファイル / 1050 件成功、スキップなし（200.70 秒）。既存の AskUserQuestion 結合テストの React 重複 key 警告は継続する。
- `typecheck` / `lint` / `package`（icon・build・electron-builder を含む）: 成功。
- `git diff --check`: 成功。
- workflow runtime の2ファイルには Prettier の整形警告があったため、動作を変えず整形した。整形後の runtime テスト39件と build は成功。ASAR 内の main / preload / renderer HTML と再ビルド結果の一致も確認済み。
- 配布先の `SHA256SUMS.txt` と exe / README の実ファイルのハッシュ一致を確認済み。
- `Get-AuthenticodeSignature`: 両 exe とも `NotSigned`（設計どおり未署名）。

## 配布物

`D:\AIwork\XHarness-release\20261004-all-fixes\XHarness-0.0.0\`

| ファイル | SHA-256 |
|---|---|
| XHarness-Setup-0.0.0.exe | `9d20d45a872e1c1d8878fa616dfca1eca42377e31caee498ffe7e012afb29bdf` |
| XHarness-0.0.0-portable.exe | `c9f433d16b8d3a5d1045a4920b5eca9f68baa9af250c14d45defcfb6c52cfc92` |
| README.md | `f9c1f831a722c28c2f6edddb334cc2ee4fbdc951908f28f95eeee99a2a4b4924` |

## 停止・未確認事項

- 配布前の追加 `Task` レビューは `Unknown agent or invalid Task` で起動できなかった。`Task` の任意引数 `previousChildId` に空文字を渡すと、存在する引き継ぎIDでないため検証が失敗する実装になっている。新規レビューに引き継ぎがない場合、この引数は省略すべきだった。資格情報やインストール環境の不備とは判定していない。
- ASAR 比較の初回は推移依存の `@electron/asar` をルートから解決できず失敗し、次は Windows のアーカイブ内パス区切りで失敗した。実際の依存位置と `path.join` に変更して main / preload / renderer HTML の一致を確認済み。
- 新版の unpacked exe を `--fake`・専用 `XHARNESS_HOME` で起動したが、ウィンドウを表示せず終了コード0で終了。既存のインストール済み XHarness が稼働しており、アプリの単一起動制限と整合する。終了理由の断定や画面の起動成功扱いはしない。キャッシュのアクセス拒否ログも出た。既存アプリは終了していない。
- インストール・新版の画面表示・スクロール/停止ボタンの実操作・実 API は未確認。ユーザーが既存アプリを閉じた後、上記インストーラを使って確認する必要がある。
- この文書だけではレビュー合格・コミット・マージ・push 完了を証明しない。最終状態はワークフローの `RequestReview` 結果と Git の履歴・remote ref で確認する。

## 正式レビュー後の3件の修正（2026-10-04）

前回の `RequestReview` で出た `should` 3件を、ユーザーの追加依頼により修正した。上記 `20261004-all-fixes` の配布物はこの修正を含まない。修正版は別フォルダに保管し、古い配布物を上書きしていない。

- 使用量: `windowMinutes` が欠けた更新を、同じ名前かつ期間が矛盾しない既知枠へ統合。既知の期間・使用率・resetを保持し、新しい使用率を表示と Router の quota に反映する。期間の初回確定・primary/secondary の逆順・0%・resetのみの更新を回帰テスト化した。
- 実装モデルの由来: 読み取りや検証の Bash では実装モデルを上書きしない。成功した Write / Edit / MultiEdit と既知の変更コマンドのみを由来の証拠にし、任意スクリプトの副作用は推定しない。この分類はモデル由来専用で、既存の権限判定は変更していない。worker の Astra fallback の後に main の Luna が読み取り・テスト・パイプ付き調査を行っても、レビューは Astra を使うことを確認した。Set-Content / git restore では変更元の Luna を記録する。
- reviewer のコマンド: 固定の `scripts/pnpm.ps1` に対する test / lint / typecheck / build（任意の run 接頭辞、追加引数なし）だけを許可。Windowsでローカルpnpmとラッパーが実ファイルとして存在するとき、そのラッパーのテストコマンドを案内する。任意スクリプト・インストール・連結・展開・リダイレクトの拒否は維持する。Bashツールからリポジトリのラッパーと一時的なローカルpnpm代替を実行し、引数が渡ることも通信なしで確認した。

### 修正版の検証

- 環境は上記と同じ Node.js 24.16.0 / WindowsApps版 PowerShell 7.6.6 / ローカルpnpm 10.34.6。今回も実体を確認した。
- 最終版の `./scripts/pnpm.ps1 test --maxWorkers=1`: **136ファイル / 1156件成功**（181.63秒、スキップなし）。worker環境で報告された replay / images の失敗は、この統合環境の全体試験では再現しなかった。
- `typecheck` / `lint` / `package`（icon・build・electron-builderを含む）: 成功。
- ASAR 内の main / preload / renderer HTML と最終ビルド出力の一致、配布先の `SHA256SUMS.txt` と実ファイルのハッシュ一致を確認済み。
- `git diff --check`: 成功。usageテストのPrettier警告も整形した。
- 両exeは `NotSigned`。インストール・新版画面操作・実API通信は今回も行っていない。稼働中の既存アプリは終了していない。

### 修正版の配布先

`D:\AIwork\XHarness-release\20261004-review-fixes\XHarness-0.0.0\`

| ファイル | SHA-256 |
|---|---|
| XHarness-Setup-0.0.0.exe | `c23512e5ff604bfc28bc30e17471411f201b309303ea6439f684b1201ab981dd` |
| XHarness-0.0.0-portable.exe | `e53f5447ce150bfb8f1440ca35258f12578e0f3c4aafc734f51d99df8a9b380b` |
| README.md | `f9c1f831a722c28c2f6edddb334cc2ee4fbdc951908f28f95eeee99a2a4b4924` |

この記録は正式な再レビュー前に作成した。再レビューの合否とmainへの統合・pushの最終状態は、最後の `RequestReview` 結果とGitのremote refで確認する。
