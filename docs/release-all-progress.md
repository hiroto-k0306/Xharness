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
- 3件の修正統合時点の `./scripts/pnpm.ps1 test --maxWorkers=1`: **136ファイル / 1156件成功**（181.63秒、スキップなし）。worker環境で報告された replay / images の失敗は、この統合環境の全体試験では再現しなかった。
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

### 再レビューで見つかった引用符内の区切りの修正

- `779d249` の正式再レビューは `should` 1件。`rg 'set-content|add-content|out-file' src` の引用符内の `|` をコマンド区切りと誤認し、由来を上書きするケースが残っていた。
- `af853ab` で由来専用の分割を引用符・PowerShellのバックティックescape・コメントを考慮するものへ変更。構文が不確かなコマンドは変更の証拠にしない。権限判定用の既存 `subcommands` は変更していない。
- 単引用符/二重引用符の検索、引用符内のセミコロン、連続引用符、escape、コメント、未閉鎖引用符、実際のパイプ書き込みと連結書き込みの9ケースを追加。runtimeの59テストが成功。
- **引用符内の区切り修正時点の全体テストは136ファイル / 1165件成功**（185.35秒、スキップなし）。typecheck / lint / package / Prettier / diff --checkも再確認し成功。最終ASARのmain / preload / renderer HTMLとビルド出力の一致、配布先のハッシュ一致を確認した。両exeは未署名。インストール・新版UI操作・実API動作試験は未実施のまま。
- `20261004-review-fixes` のexeはこの追加修正を含まない。この時点の配布物は次のフォルダに保存した（既存配布物は上書きしていない）。ただし、その後の再レビューで下記の残件が見つかったため、現在の最新版ではない。

`D:\AIwork\XHarness-release\20261004-review-fixes-final\XHarness-0.0.0\`

| ファイル | SHA-256 |
|---|---|
| XHarness-Setup-0.0.0.exe | `941f4d35755289f9fd20672bc14dbda384428a69b7ce112d140cfe3fdfacce2d` |
| XHarness-0.0.0-portable.exe | `ca55d8400a8e625ffa19622329597cb5e852718398a4c7c297b1a3fb5265c6e1` |
| README.md | `f9c1f831a722c28c2f6edddb334cc2ee4fbdc951908f28f95eeee99a2a4b4924` |

## 再開後の引用符付き書き込みの修正（2026-10-04）

- `9c78267` の正式再レビューに残った `should` 1件を、ユーザーの再開指示により修正した。引用符を考慮した分割後も、権限判定用の `analyzeCommand(...).simple` が引用符内の `;` 等を拒否していたため、実際の `Set-Content P1.txt 'const value = 1;'` による変更元モデルを記録できなかった。
- `0fc8558` で由来専用の分類を修正。コマンドの原文と引用符外の実行構文を分け、引用符内の内容は構文判定に用いない。引用符外の不確かな式・展開等は引き続き証拠にしない。権限判定・承認ルールは変更していない。
- 単引用符・二重引用符それぞれで `;` / `|` / `$` を含む6ケースを追加。WindowsではBashツールの実体を使い、一時作業フォルダのP1.txtに実際に書き込み、内容・成功レシート・Lunaへの由来更新・Lunaによるfallbackレビューを確認した。Windows以外では分類用の模擬レシートで検証し、PowerShellは起動しない。裸の引用符付きコマンド名が文字列式であること、および引用符外の不確かな変数を誤認しないことも追加。runtimeの**68テスト成功**。
- 実行環境はNode.js 24.16.0 / WindowsApps版PowerShell 7.6.6 / ローカルpnpm 10.34.6。Node・pwshの版と実体を再確認し、上記と一致した。
- 引用符付き書き込み修正時点の全体テスト: **136ファイル / 1174件成功**（210.53秒、スキップなし）。typecheck / lint / package / Prettier / diff --checkも成功。最終ASARのmain / preload / renderer HTMLとビルド出力が一致し、配布先のSHA-256も一致した。
- インストール・新版UI操作・実API動作試験は未実施。稼働中の既存アプリは終了していない。資格情報の読み取り・更新は行っていない。両exeは未署名。

### トークン解析修正前の配布先

`D:\AIwork\XHarness-release\20261004-quoted-write-fix\XHarness-0.0.0\`

`20261004-review-fixes-final` を含む以前の配布物には今回の残件修正が入っていない。既存フォルダは上書きしていない。

| ファイル | SHA-256 |
|---|---|
| XHarness-Setup-0.0.0.exe | `9420b7b0cc5329210b899d073a8e1caf46dd00dd2b5fac29ebfbd0ecac32f875` |
| XHarness-0.0.0-portable.exe | `0d7e63cc95233122c0381f200b58b5195073665ff6d9a27b30ced0d993c3fc6b` |
| README.md | `f9c1f831a722c28c2f6edddb334cc2ee4fbdc951908f28f95eeee99a2a4b4924` |

### 続けて見つかったトークン解析の修正

- `9ad477e` の正式再レビューで `should` 1件。権限判定用のトークン解析がPowerShellのバックティックescapeに非対応なため、読み取り用の ``sed -n "/`" -i /p" P1.txt`` のパターン内の `-i` を書き込みオプションと誤認することが分かった。
- `9cface5` で由来専用の `attributionTokens` を追加し、backtick escapeと引用符内の連続引用符を扱うよう修正。由来判定から `analyzeCommand` の利用を完全に取り除いた。権限判定のコード・ルールは変更していない。
- 上記の読み取り、パターン内の `--in-place`、単引用符内の連続引用符を含む読み取りでAstraを維持し、実際の `sed -i` 形式ではLunaを記録する4ケースを追加した。sedのケースは模擬レシートによる分類試験であり、sed自体の実行試験ではない。先の6ケースのPowerShell実書き込みも含め、runtimeの**72テスト成功**。
- 最終版の全体テスト: **136ファイル / 1178件成功**（198.29秒、スキップなし）。同じWindows環境でtypecheck / lint / package / Prettier / diff --checkを再実施し成功。最終ASARとビルド出力の一致・配布物のSHA-256一致を確認した。両exeは未署名で、インストール・新版UI実操作・実API試験は未実施のまま。

### 最新の配布先

`D:\AIwork\XHarness-release\20261004-quoted-write-final\XHarness-0.0.0\`

`20261004-quoted-write-fix` を含む以前の配布物にはトークン解析の追加修正が入っていない。以前の配布物は上書きしていない。

| ファイル | SHA-256 |
|---|---|
| XHarness-Setup-0.0.0.exe | `03de9fe4ea0015236ad473ec266a9056286a3796eddc666bd951c4b2ad5913e3` |
| XHarness-0.0.0-portable.exe | `61ff9683be220519247725d6876167a76f12e86ef5a83fbca31ddc01a0096f1c` |
| README.md | `f9c1f831a722c28c2f6edddb334cc2ee4fbdc951908f28f95eeee99a2a4b4924` |

この追記は最終の正式再レビュー前に作成した。再レビューの合否とmainへの統合・pushの最終状態は、最後の `RequestReview` 結果とGitのremote refで確認する。
