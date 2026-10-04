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

## 残存 should 2件への修正（2026-10-04）

- 画像ラベルの保護を destination の認識から独立させた。reference画像・title付きinline画像・空のreference・destinationなしでも、ラベル内の入れ子リンクを起動リンクへ変換せず、画像表記を文字のまま保持する。保護区間外の通常リンクは維持する。
- バッククォートフェンスの info string にバッククォートを許さない。行頭の三重バッククォートinline spanを未閉鎖フェンスと誤認して、後続行の通常リンクまで消す問題を修正した。チルダフェンスと既存のコード保護は維持する。設計変更・依存追加はない。
- 回帰テスト9件（画像6件・inline span3件）を追加し、修正前に9件すべての失敗を確認した。修正後の `TextLinks` は **28件成功**。関連7ファイル（local-links、local-links-ipc、preload/local-links、TextLinks、tools/environment、Transcript、App）を `scripts/pnpm.ps1 test ... --maxWorkers=2 --testTimeout=30000` で実行し、**108件成功**。実Windowsドライブ照会・WindowsApps aliasの実行も成功。既存AppテストのReact重複key警告は引き続き出る。
- Windows / Node.js 24.16.0 (`C:\Program Files\nodejs\node.exe`) / PowerShell 7.6.6 Store版 (`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`) / workspace内のローカルpnpm 10.34.6を使用した。
- typecheck、lint、electron-vite build、変更3ファイルのPrettierチェック、`git diff --check` は成功。編集ツールによるファイル名の小文字化で最初のtypecheckが大文字小文字の不一致を検出したため、Git登録どおりの `TextLinks.tsx` に戻して再実行した。全テスト・GUI確認・exe生成・実API通信は今回も行っていない。上記の全テスト既知失敗と以下のGUI制約は変わらない。

## main での最終検証（2026-10-04）

- 追加の should: 複数行の画像ラベルも括弧の対応が閉じるまで保護する。LF／CRLF の回帰2件で、画像内のリンクは起動できず、画像後の通常リンクは維持されることを確認した。この時点のTextLinksは30件成功、typecheck・lint成功。
- main の全体テスト（並列2）は139ファイル・1253件成功、phase5の既存待機で1件タイムアウト。worktreeで失敗していたreplayはmainでは成功。後続の並列1での再確認は、以下のとおり全件成功した。

## 最新レビューの should 2件への修正・再検証（2026-10-04）

- 画像ラベル内のinline codeを同じ長さのバッククォートまで読み飛ばし、コード内の `[` / `]` をラベルの括弧対応に数えない。任意長・複数行のコードを含む画像も文字のまま保持する。
- 画像のURL・titleを、引用符・エスケープ・山括弧・丸括弧の入れ子を考慮して最後までまとめて保護する。画像title内のリンクと、画像をラベルに含む外側のリンクは起動できない。入れ子画像のtitle内の角括弧も外側のラベルを閉じない。保護範囲の外のfile / HTTPSリンクは維持する。
- 簡易リンク形式として認識したdestinationが保護範囲の全体と一致するときだけリンクにする。未対応の括弧入りURLなどで、途中までのURLを誤って起動リンクにしない。完全なMarkdown解釈・依存追加・設計変更はしていない。
- 回帰18件を追加（最初の12件は修正前に11件失敗・1件成功を確認）。TextLinksは **48件成功**。
- `scripts/pnpm.ps1 test --maxWorkers=1 --testTimeout=30000 --reporter=dot`: **140ファイル・1275件、全件成功**。phase5の既存待機タイムアウトとreplayも今回は成功。過去の失敗は履歴として上に残している。Appの既存React重複key警告は残る。
- typecheck、lint、electron-vite buildは成功。初回typecheckのstrictな文字列添字検査を修正して再実行した。進捗の「再確認中」を実結果に更新し、文字化け指摘のあった文をUTF-8で書き直した。
- Windows / Node.js 24.16.0 (`C:\Program Files\nodejs\node.exe`) / PowerShell 7.6.6 Store版 (`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`) / ローカルpnpmを使用。GUI確認・exe生成・新規API疎通試験・資格情報更新はこの修正作業では行っていない。

## 残存 nit 2件への修正（2026-10-04）

- 通常リンクのラベルに空行（LF／CRLF、空白・タブだけの行を含む）がある場合はリンク化しない。単一改行のラベルと、画像ラベル全体の保護は維持した。
- 通常destinationを画像の保護用走査から分離し、titleの終端と外側の閉じ括弧が構文として揃う場合だけ文字のまま保護する。`[a](b 'c) ... [file](file:///C:/a.txt) ... 'z')` や段落をまたぐ不正titleが、後続の正常リンクを飲み込まなくなった。title付きリンクをクリック可能にする機能追加はしていない。
- 非エスケープの引用符／山括弧の閉じ位置を事前索引化し、丸括弧の閉じ位置・未閉鎖の結果も再利用する。画像ラベル内コード・title・入れ子画像の保護と、未対応の括弧入りURL／エスケープ閉じ括弧を含むURLを文字のまま保持する挙動を維持した。依存追加・設計変更はない。
- 回帰テストを23件追加。Node.js 24.16.0／22.23.3の両方で **TextLinks 71件成功**。長文は通常／画像destination・不正引用符・括弧入りURLを各30,000反復（120,000〜210,000文字）し、後続リンクと文字列が維持されることを確認した。
- Node.js 24.16.0でSSR描画を各5回測定した中央値: `[a](` の反復は4,000文字0.8ms、8,000文字0.9ms、16,000文字1.1ms、32,000文字2.2ms、64,000文字4.1ms、120,000文字6.7ms。修正前の32,000文字は663.4ms（各3回の中央値）。今回の反復入力では概ね線形の増加を確認した。任意のMarkdown入力すべてについて線形時間を保証するものではない。
- 検証環境: Windows、Node.js 24.16.0 (`C:\Program Files\nodejs\node.exe`) で上記の対象テスト・性能測定。今回、`scripts/pnpm.ps1 exec node -p process.execPath`／`--version` により、ローカルpnpm配下の実行Nodeは **22.23.3** (`D:\AIwork\Xharness\.tools\node_modules\node\bin\node.exe`) と確認した。pnpm経由のtypecheck・lint・build・全体テストはこのNode 22での検証として区別する。過去の作業の子プロセスのNode実体は今回再確認していない。
- PowerShell 7.6.6 Store版 (`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`) を使用。初回typecheckの編集ツールによるファイル名小文字化をGit登録どおりに戻して再実行し、typecheck・lint・buildは成功。変更3ファイルのPrettierチェック・`git diff --check`も成功。以下の再レビュー追加修正前の `scripts/pnpm.ps1 test --maxWorkers=1 --testTimeout=30000 --reporter=dot` は **140ファイル・1298件、全件成功**（Node.js 22.23.3）。既存AppテストのReact重複key警告は残る。
- 再レビューのshould 2件にも対応: 空白／空行の累積数による区間判定と、ラベルの入れ子・未閉鎖結果の再利用を追加した。括弧が閉じていても空白／空行で不正になるdestinationと、閉じない `[`／`![`、空行を含む入れ子ラベルを各30,000反復する回帰6件を追加。Node.js 24.16.0／22.23.3で **TextLinks 77件成功**。typecheck・lint・buildも再実行して成功。追加修正後の最終全体テスト（Node.js 22.23.3、同じ並列1・30秒のコマンド）は **139ファイル成功・1ファイル失敗、1303件成功・1件失敗**。既存 `src/main/session/phase4.test.ts` のmanual compact後のresume試験が、内部待機の3秒制限（79行／125行）で失敗した。このファイルを同じNode・引数で単独再実行すると **5件成功**。既存コード・待機上限は変更しておらず、最終全体テストを全件成功とは報告しない。
- この追加修正後のNode.js 24 SSR中央値（各5回）: `[a](` の32,000文字8.1ms、64,000文字11.9ms、120,000文字27.3ms。レビューの括弧が閉じた不正URLは64,001文字10.3ms／128,001文字14.3ms／240,001文字34.6ms、不正titleは72,002文字9.6ms／144,002文字20.5ms／270,002文字38.9ms。未閉鎖ラベル・画像ラベル・角括弧と空行入り入れ子ラベルも30,000反復で5.0〜6.3ms。今回確認した入力の二次時間傾向を解消した。
- この時点では再レビューのnit 4件が未対応だった: 不正な画像titleでは安全側の保護によって後続リンクも文字のままになる場合がある、リンクのない文章でも毎描画で索引を作る、性能回帰の自動テストは時間／走査数をassertせず手動測定に依存する、未対応の山括弧destination付き通常title（例: `[x](<url> "[file](file:///C:/a.txt)")`）ではtitle内リンクがリンク化される場合がある。最後の形式は従来の丸括弧保護と異なり、ローカル起動は引き続きネイティブ確認が必須。当時は追加対応しなかった。後続の対応は次節に記録する。
- GUI確認・配布exe再生成・コミット・pushは今回未実施。新規の実API疎通・資格情報の読み書きは行っていない。

## 最終レビューの nit への修正・再検証（2026-10-04）

- 通常リンクと画像でdestination／titleの構文検証を共用した。山括弧destination付き通常title（例: `[x](<url> "[file](file:///C:/a.txt)")`）も、画像と同様に全体を文字のまま保護し、title内をリンク化しない。titleや山括弧destinationをクリック可能にする機能追加はしていない。URL中の `<` / `>` を一律に除外していた点も修正し、titleなしの `[web](https://example.com/?q=<x>)` は従来のHTTPSリンクとして扱う。HTMLを解釈しない挙動は維持する。
- 不正画像titleの後にある正常なfile／HTTPSリンクを飲み込まないようにした。title終端と外側の閉じ括弧を検証し、段落をまたぐtitleも拒否する。画像ラベル内のコード・入れ子リンクは引き続き起動できない。括弧入り／エスケープ閉じ括弧入り画像URLと完全なtitleはまとめて保護する。
- `[` のない本文はdelimiter索引と2本の累積数配列を作る前に返す。`React.memo` により同じtextでの再描画時も解析を繰り返さない。配列構築を監視するテストで、リンクなし本文・同じ本文の再描画・本文変更時の再解析を確認した。
- 長文9ケースのSSRに、`performance.now()` で計測した経過時間 **1,000ms未満** のassertを追加した。各30,000反復の未閉鎖通常／画像URL・title・ラベル・角括弧と、括弧が閉じた不正URL／title・空行入りラベルを対象とする。同期の再走査はVitestのtimeoutだけでは止められないため、DOM作成を除いた経過時間を明示判定する。通常の数十msに対して余裕を取った回帰検知であり、任意のMarkdown入力すべての線形時間を保証するものではない。
- 前回の最終レビューでは、**既定の並列・5秒タイムアウト** の全体テストで **140ファイル中19ファイル失敗、1304件中32件失敗** と報告された。多くはタイムアウトで、TextLinksのテストは失敗していなかった。このレビュー結果は、上の並列1・30秒による1303件成功／1件失敗とは別の実行である。今回、既定の並列条件では全体テストを再実行しておらず、既定条件の不安定性が解消したとは報告しない。
- 今回は回帰・性能テストを25件追加し、**TextLinks 102件成功**（Node.js 24.16.0／22.23.3）。Node 24では `node node_modules/vitest/vitest.mjs run src/renderer/components/TextLinks.test.tsx --maxWorkers=1 --reporter=dot`、Node 22では `scripts/pnpm.ps1 test src/renderer/components/TextLinks.test.tsx --maxWorkers=1 --reporter=dot` を実行した。
- 今回の全体テスト `scripts/pnpm.ps1 test --maxWorkers=1 --testTimeout=30000 --reporter=dot` は **140ファイル・1329件、全件成功**（Node.js 22.23.3、252.28秒）。以前失敗したphase4／phase5／replayも今回は成功した。既存AppテストのReact重複key警告は残る。既存の待機制限や他のテストは変更していない。
- Windows / PowerShell 7.6.6 Store版 (`C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`) を実体まで再確認した。Node 24は `C:\Program Files\nodejs\node.exe`、pnpm配下のNode 22は `D:\AIwork\Xharness\.tools\node_modules\node\bin\node.exe` と再確認し、検証条件を区別する。typecheck・lint・electron-vite buildはNode 22で成功。変更3ファイルのPrettierチェック・`git diff --check`も成功。設計変更・依存追加・実API通信・資格情報の読み書きは行っていない。

## 追加 nit 4件への修正・再検証（2026-10-04）

- 性能回帰の経過時間上限を **1,000ms → 5,000ms未満** に広げ、各性能ケースのVitest timeoutも30秒に明示した。同期SSRの経過assertは維持し、重い再走査を検知する粗い上限とテスト全体のtimeoutを区別する。リンクを含まない690,000文字の本文もSSR試験に追加し、早期返却経路で文字が保持され、リンクが生成されないことを確認する。性能試験は計10ケース。負荷による誤検知を軽減する変更であり、CI／別の低速機での実測や、あらゆる負荷条件での成功保証は行っていない。
- 純粋な解析処理を `text-links-parser.ts` に分離した。解析アルゴリズム・保護範囲・起動可能な形式は変えていない。memoのテストは、実際の解析関数を呼ぶmodule spyで「同じtextなら呼び直さず、異なるtextなら再解析する」ことを検証する。`Uint32Array` のグローバルstubと配列確保数への依存を除去し、累積数配列を別の構造に変えてもmemoのテストが影響されないようにした。
- **互換性の制約**: バックスラッシュを含むHTTPS destination（例: `[a](https://example.com/a\b)`）は、前回修正で未対応形式として文字のまま保護する扱いに統一した。以前リンク化されていた一部のURLもクリック可能にしない。エスケープ閉じ括弧を含むHTTPS URLも同じ扱い。両形式の回帰テストを追加した。URL中の `<` / `>` の互換復元とは別の制約であり、HTTPS URLは `/` を使って記述する。
- 直前の正式レビューによる既定並列・5秒の再実行は、**140ファイル中13ファイル失敗、1329件中20件失敗、88.85秒** と報告された。handoffs、images、phase4、phase5、premises、slash-controller、trust、runtime、background-shellsなどのタイムアウト／待機上限による失敗で、TextLinksは含まれない。上の19ファイル／32件失敗とも、並列1・30秒の成功とも別の実行として記録する。既定条件の不安定性はこのタスクで修正していない。
- 今回のTextLinksは **105件成功**（Node.js 24.16.0／22.23.3）。前回の102件を維持し、バックスラッシュHTTPSの2件とリンクなしSSRの1件を追加した。対象テストは前節と同じNode別コマンドで実行（Node 24のreporterのみdefault）。
- 今回の全体テスト `scripts/pnpm.ps1 test --maxWorkers=1 --testTimeout=30000 --reporter=default` は **140ファイル・1332件、全件成功**（Node.js 22.23.3、281.05秒）。既存AppテストのReact重複key警告は残る。既定並列条件とNode 24の全体テストは今回再実行していない。
- Node／PowerShellの版と実体を再確認した。Node 24: `C:\Program Files\nodejs\node.exe`（24.16.0）、pnpm配下のNode 22: `D:\AIwork\Xharness\.tools\node_modules\node\bin\node.exe`（22.23.3）、PowerShell: `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`（7.6.6 Store版）。typecheck・lint・electron-vite buildはNode 22で成功。変更4ファイルのPrettierチェック・`git diff --check`も成功。設計変更・依存追加・実API通信・資格情報操作・GUI確認・exe再生成・コミット・pushは行っていない。

## 未実施・制約

- **Electron GUIでのクリック／キーボードによるリンク起動、ネイティブ確認のフルパス表示、既定アプリ起動、Explorer選択、Cancel／Escapeと連続操作は未検証。手元で実施が必要。**
- 最新の全体テストはNode.js 22.23.3の並列1・30秒で140ファイル・1332件成功。既定並列・5秒の全体テストはmainでは今回未実施で、上記のレビューで再現した不安定性は未解消として扱う。Node.js 24.16.0ではTextLinksの105件（明示的SSR時間上限を含む）のみを再実行し、今回の全体テストは実行していない。Node.js 22互換は22.23.3で確認した範囲に限り、22.20そのものは未検証。
- 実GUIで `.txt` と安全な検証用プログラム／スクリプト、フォルダ、日本語・スペースを含むパスを確認し、キャンセル時は何も開かないこと、同じリンクも毎回聞くこと、HTTPSが既定ブラウザへ開くことを確かめる。
- GUIでUNC・割当リモートドライブ・存在しない対象・合成クリック（DevToolsからの `.click()`）が起動しないことも確認する。実際のUNC／ネットワークドライブは未接続。
- mainの最終検証とOSの起動は原子的ではない。最後の検証後の外部プロセスによる差し替えまで防ぐサンドボックスではない。ローカルファイルの内容やショートカットの実行先の安全性を保証しないため、確認には実行の警告を表示する。
