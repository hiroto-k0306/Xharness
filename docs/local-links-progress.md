# 確認付きローカルファイルリンク（2026-10-04）

## 実装

- DESIGN.md §14.2 のユーザー承認済み対応。起動対象は Windows のローカル絶対 `file:///C:/...` URL のみ。
- この作業ツリーの既存 Transcript は Markdown を解釈しないプレーンテキスト表示だったため、`TextLinks` で明示的な `[ラベル](URL)` だけを React の要素へ変換した。HTML・ラベルはエスケープを維持し、画像・コードを起動リンクにしない。新しい HTML 解釈やパーサ依存は導入していない。HTTPS は `_blank` と既存 main の HTTPS 専用 `openExternal` 経路を維持する。
- preload 内部でリンクの実クリック（`isTrusted`、ユーザーactivation）を捕捉する。ローカルリンク起動APIは `window.harness` に公開せず、一般の command でも受け付けない。main は自分のウィンドウの mainFrame と Chromium のユーザーactivation を再確認する。`executeJavaScript` にユーザーgestureを作る指定は渡さない。
- main は URL の厳格な検証、実体パスの解決、通常ファイル／ディレクトリの確認、Windows `GetDriveType` によるドライブ確認を行う。UNC、ホスト付きfile URL（localhostも含む）、割当リモートドライブ、デバイスパス、相対パス、ADS、予約名、制御文字、不正エンコード、曖昧な末尾、クエリ／フラグメントを拒否する。PowerShell が使えない／照会に失敗した場合も拒否する。照会用 PowerShell は既存 `resolveCli("pwsh")` で絶対パスへ解決してから起動し、未解決名による CWD の exe 検索は行わない。
- 毎回ネイティブ確認に解決済みフルパスと実行リスクを表示する。「キャンセル」が既定・Escape、「実行」は既定アプリで開く、「フォルダを開く」はファイルの場合Explorerで選択、フォルダの場合そのフォルダを開く。確認の保存・自動許可はない。
- 承認後も実体・ファイル識別情報・ドライブ・ウィンドウを再検証する。確認中の差し替え、ウィンドウ終了、二重要求を拒否する。生のOSエラーをIPC／ログへ出さない。

例: `[日本語のファイル](file:///C:/work/%E6%97%A5%E6%9C%AC%20file.txt)`。スペースなどはURLエンコードする。

## 検証環境

- Windows、Node.js 24.16.0: `C:\Program Files\nodejs\node.exe`
- PowerShell 7.6.6（WindowsApps / Store版）: `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`
- ローカル pnpm 10.34.6、`scripts/pnpm.ps1` を使用。実API通信・資格情報の読み書き・exeの生成は行っていない。
- 実ドライブ照会ではこの作業ツリーのローカルドライブを確認した。UNC／リモート実体／割当リモートドライブ／照会失敗の拒否は単体テストで差し替えて確認した。実際のネットワークドライブは作成・接続していない。

## テスト結果

- 追加のURL／実体・ドライブ検証、承認／取消／再検証／二重要求、IPC送信元・mainのactivation照会、preloadの合成クリック拒否、rendererのHTML・危険スキーム・コード・画像の扱いを試験した。
- 最初の追加＋関連テスト: 6ファイル・67件成功。その後、予約名の追加ケースと実ドライブ照会テストのタイムアウトを調整した。
- 最終の追加＋関連テスト（上記6ファイル、`--maxWorkers=2`）: **69件成功**。
- typecheck、lint、electron-vite build、変更したコードのPrettierチェックは成功。
- 初回の全テストは1213件成功・6件失敗。自身の実ドライブ照会と既存のcontroller／imagesで5秒タイムアウト、controllerの後続assertionとphase5の待機タイムアウトが発生したため、並列数を減らして再実行した。
- 全テスト再実行 `scripts/pnpm.ps1 test --maxWorkers=2 --testTimeout=30000`: **139ファイル成功・1ファイル失敗、1220件成功・1件失敗**。追加テストはすべて成功し、初回のタイムアウト系失敗も解消した。全テスト成功とは報告しない。
- 既存 `src/main/session/replay.test.ts` の実Haiku fixture比較は、この作業ツリーの外にある記録時の `D:/AIwork/Xharness/.out/phase6-auth-work/a.txt` を `process.cwd()` 内としてallowと期待しているため失敗する。このタスクではfixture・既存replayテストを変更していない。

## 正式レビュー指摘への修正（2026-10-04）

- DESIGN.md §14.2 の「コード・画像をリンクとして起動しない」「ドライブ照会失敗は拒否」を再確認した。設計の変更や依存追加はない。
- **must**: `isLocalDrive` は `resolveCli("pwsh")` の解決済み絶対パスだけを `execFile` に渡す。未解決・相対パス・解決時エラーは起動せず拒否する。未解決 `pwsh` の Windows 検索によって確認前に CWD の攻撃 exe を実行する経路を除去した。起動引数と起動しないケースの回帰テストを5件追加した。
- **should**: `TextLinks` はリンクより先に保護区間を走査する。同じ長さの任意長バッククォートで閉じるインラインコード（改行も含む）、バッククォート／チルダのフェンス（開始以上の長さの閉じフェンス、未閉鎖は末尾まで）、入れ子の画像ラベルを文字のまま保持する。二重バッククォート、`~~~`、`[![preview](file:///C:/a.png)](https://example.com)` とその逆のスキーム、保護区間外の通常リンクを含む回帰テストを17件追加した。
- 今回も Windows / Node.js 24.16.0 (`C:\Program Files\nodejs\node.exe`) / PowerShell 7.6.6 Store版 (`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`) を使用。新規worktreeに `.tools` がなかったため、workspace内へローカル pnpm 10.34.6 を準備し、`scripts/pnpm.ps1 install --frozen-lockfile` で依存を導入した。
- 変更した2テストファイルは **61件成功**（実Windowsドライブ照会を含む）。関連テスト7ファイル（local-links、local-links-ipc、preload/local-links、TextLinks、tools/environment、Transcript、App）は `--maxWorkers=2 --testTimeout=30000` で **99件成功**。WindowsApps alias の解決・実行も成功した。Appの既存テストではReactの重複key警告が出るが、テスト自体は成功した。
- typecheck、lint、electron-vite build、変更したファイルのPrettierチェックは成功。今回の全テスト再実行・GUI確認・exe生成・実API通信は行っていない。上記の全テスト既知失敗と以下のGUI制約は引き続き残る。

## 未実施・制約

- **Electron GUIでのクリック／キーボードによるリンク起動、ネイティブ確認のフルパス表示、既定アプリ起動、Explorer選択、Cancel／Escapeと連続操作は未検証。手元で実施が必要。**
- Node.js 22.20以降での互換実行は未実施（今回の検証は24.16.0）。
- 実GUIで `.txt` と安全な検証用プログラム／スクリプト、フォルダ、日本語・スペースを含むパスを確認し、キャンセル時は何も開かないこと、同じリンクも毎回聞くこと、HTTPSが既定ブラウザへ開くことを確かめる。
- GUIでUNC・割当リモートドライブ・存在しない対象・合成クリック（DevToolsからの `.click()`）が起動しないことも確認する。実際のUNC／ネットワークドライブは未接続。
- mainの最終検証とOSの起動は原子的ではない。最後の検証後の外部プロセスによる差し替えまで防ぐサンドボックスではない。ローカルファイルの内容やショートカットの実行先の安全性を保証しないため、確認には実行の警告を表示する。
