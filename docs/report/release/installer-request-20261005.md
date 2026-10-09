> 過去の記録：移動元 `docs/installer-request-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 起動中アプリを保全したインストール前確認（2026-10-05）

ユーザーの「インストーラー作成してインストールしてみて」「既にアプリ起動中です」を受け、`review/integrated-release` の `78db414bf4ee4340661ac355eca2f919d1c7f548` からNSISインストーラーを新規作成した。製品ソースは `0d46864` 以降変更なし。今回は既存版を終了・上書きする前に知らせて待つという条件に従い、**インストーラーの起動・設置・更新は保留**した。

## 起動中版と保存状態

読み取り確認した本体は `C:\Users\ahwri\AppData\Local\Programs\XHarness\XHarness.exe`、main PID `36160`、子PID `27208`／`10628`／`15776`。window titleは `XHarness`。実体FileVersionは `0.0.0`、ProductVersionは `0.0.0.0`、installed ASARのpackage versionは `0.0.0`。そのASARのSHA256は `d55bc8c2da829934c2908d8b9df510afba19230c4bc20ef86194cd3870dc7a15`。インストール済み版の元Git revisionはこれだけでは分からない。

UI Automationは既知main windowの読み取りだけを行った。accessible buttonはwindow controls相当の3件のみで、停止ボタンを取得できず、**全タスクの実行終了・保存完了は確認できなかった**。停止ボタン未取得をidleの証拠にしない。クリック・キー送信・再起動・プロセス終了は一切行っていない。

調査したHKCU／HKLMのUninstall範囲ではDisplayNameがXHarnessに一致する登録を取得できなかった。一方、既存directoryには `Uninstall XHarness.exe` がある。登録不存在や、同じappIdの並行インストールが安全であるとは断定しない。

## 別directoryでは独立インストールを保証できない理由

現行 `electron-builder.yml` は `appId: local.xharness.app`、`productName: XHarness`、NSIS `oneClick:false`／`perMachine:false`／`allowToChangeInstallationDirectory:true`。directory選択はできるが、インストール識別子を分ける設定ではない。

既存electron-builder 26.15.3の静的ソースでは、`NsisTarget.js` がappIdから固定GUIDを導出し、`multiUser.nsh` がGUID／UNINSTALL_APP_KEYから共通のインストール・アンインストール登録を決める。`installSection.nsh` はファイル設置前に `CHECK_APP_RUNNING` と `uninstallOldVersion` を呼ぶ。`allowOnlyOneInstallerInstance.nsh` は起動中のappを検出すると終了確認から停止・強制停止へ進み、PowerShellが利用不可の経路では同exe名のプロセスを対象とする。`installer.nsh` は同じ登録キーへDisplayVersion／UninstallStringなどを書き込む。

したがって `/D` やdirectory画面だけで、既存版・登録・実行中タスクを保全できる並行installとは判断しない。別appId等の専用製品variantを無断で作り、通常版のインストール確認として扱うこともしない。

## 新しく作成した成果物と検証

保存先は `C:\Users\ahwri\Documents\Codex\2026-10-05\task\install-request-78db414\XHarness-0.0.0`。既存配布フォルダーを上書きせず、installer、利用者README、`SHA256SUMS.txt` を置いた。

| 項目                | 値                                                                 |
| ------------------- | ------------------------------------------------------------------ |
| installer           | XHarness-Setup-0.0.0.exe                                           |
| bytes               | 114697211                                                          |
| SHA256              | `3a53ed93e554d8bc0846a26232db08d5dc2a52eedd8352ea305de36ecd39956d` |
| Authenticode        | NotSigned                                                          |
| 同梱app.asar SHA256 | `af389ee9839a8ff478da138b456a17d8ed438189e6c6711ebe261123af735bfd` |

Windows 11 10.0.26200 x64、Node 22.23.3／pnpm 10.34.6、PowerShell 7.6.5、既存Electron 44.5.1／electron-builder 26.15.3／NSIS cacheを使用。UI Automation読取だけは既存Windows PowerShellの.NET UIAutomationを利用した。

```powershell
$env:PATH = (Join-Path $PWD '.tools/node_modules/.bin') + ';' + $env:PATH
.\scripts\pnpm.ps1 build
.\scripts\pnpm.ps1 exec electron-builder --win nsis --config.electronDist=node_modules/electron/dist --config.directories.output=.out/installer-78db414
$env:XHARNESS_TEST_EXECUTABLE = Join-Path $PWD '.out/installer-78db414/win-unpacked/XHarness.exe'
.\scripts\pnpm.ps1 exec playwright test smoke.spec.ts release-recovery.spec.ts --output=.out/installer-78db414-gui
Remove-Item Env:XHARNESS_TEST_EXECUTABLE
```

desktop build／NSIS作成は成功。同梱実exeの起動・fake ping/pong・通常再起動・未確定fixtureからの再実行拒否は3テスト成功、4.8秒。新しく生成した専用fake homeだけを使い、既存本体PIDや既存データを操作しない。ASARの16 buildファイルは最終outと全一致。installerを実行せず、既存7-Zipで内包ASARだけを抽出して同hashを確認した。証跡は `.out/installer-78db414-audit.json`／`.out/installer-78db414-gui`／`.out/installer-78db414/payload-audit`。

これは**新しい配布exeの実起動確認**であり、Windowsへ実際にインストールされた新バージョンの起動・更新テストではない。今回の製品コード変更はないため、前段の全回帰1620件・全配布GUI21件を追加で再実行してはいない。

最後の確認でも既存main／子PID4件とinstalled ASAR hashは不変。元checkout `D:\AIwork\Xharness` は `50e7707c0704e1d5aea5818cdea4bae8a2ef7599` のままclean。既存ユーザーデータ／設定／認証の読取診断・コピー・書込や実モデル通信、認証CLI、push、mergeは行っていない。インストーラーを起動していないので、SmartScreen等の警告は未確認であり、回避していない。

## 確認後に行う操作

通常更新として進める場合、対象は上記installerと既存 `AppData\Local\Programs\XHarness`。アプリの実行ファイル・resourcesの置換、Windowsのインストール／アンインストール登録の作成または更新、既存ショートカットの更新を伴う可能性がある。ユーザーデータや認証情報を削除する操作は含めない。

まず利用者がタスク完了・保存を確認して既存アプリを通常終了し、その既存版への更新を確認する必要がある。プロセスが終了したことを再度読み取り確認してから進む。起動中版を勝手に止めず、installerの停止・強制終了に任せない。未署名警告・SmartScreen・UAC等が出た場合は操作を進めず、警告と必要な本人操作を報告する。新たな権限取得やセキュリティ設定変更を自動で行わない。
