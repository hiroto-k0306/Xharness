> 過去の記録：移動元 `docs/installed-update-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 既存インストールの承認済み更新（2026-10-05）

ユーザーの「更新して良いです」を受け、既存 `C:\Users\ahwri\AppData\Local\Programs\XHarness` を更新した。配布物の作成だけでなく、このインストール先への配置・登録・実行確認まで実施した。製品ソースは `0d468643470f13234d69b63858b55bccbe5833ec` 以降変更なし。作業ブランチは `review/integrated-release`。

## 終了・保存の確認

更新前の main PID は `36160`、子 PID は `27208` / `10628` / `15776`。既存ウィンドウだけの読み取り撮影で、4件の会話に running / ask / agents 表示がなく、選択中の会話が idle、入力欄が空で有効であることを確認した。保存済み会話4件のJSONLを解析でき、最後のトレースは `workflow_complete`、`context_overflow`、`premise_mismatch`、`完了`。`context_overflow` と `premise_mismatch` は成功とは扱わないが、実行終了記録と画面の状態が一致した。

通常の `WM_CLOSE` を検証済み main window に送り、3秒後に既存先の本体・子プロセスが残っていないことを確認した。強制終了はしていない。旧アプリ本体83ファイルを作業領域の `.out/installed-app-rollback-d55bc8c` に退避した。これはアプリ本体の復旧候補であり、ユーザーデータ全体のバックアップではない。認証ファイルは読み取り・コピー・更新していない。

## 更新と識別

使用したインストーラーは、作業領域の `install-request-78db414/XHarness-0.0.0/XHarness-Setup-0.0.0.exe`。起動直前に SHA256 `3a53ed93e554d8bc0846a26232db08d5dc2a52eedd8352ea305de36ecd39956d` を再確認した。通常の対話セットアップで既存先を確認してインストールし、完了画面の「XHarnessを実行」を外して終了した。SmartScreen・UAC・OSセキュリティ警告はこの実行では表示されず、回避操作もしていない。署名状態は従来どおり NotSigned。

| 項目                             | 結果                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------- |
| 旧 installed app.asar SHA256     | `d55bc8c2da829934c2908d8b9df510afba19230c4bc20ef86194cd3870dc7a15`              |
| 更新後 installed app.asar SHA256 | `af389ee9839a8ff478da138b456a17d8ed438189e6c6711ebe261123af735bfd`              |
| 新コードの識別                   | installer payload / win-unpacked と同じASAR hash、製品ソース `0d46864`          |
| 表示バージョン                   | 更新前後とも `0.0.0`。更新判定には使用しない                                    |
| アンインストール登録             | HKCU、キー `002fa833-a2e1-543c-b61a-e688b1b19fe9`、DisplayName `XHarness 0.0.0` |
| 登録された uninstaller           | 既存先の `Uninstall XHarness.exe`、`/currentuser`                               |
| ショートカット                   | Desktop / Start Menu の2件とも既存先の `XHarness.exe` を指す。引数は空          |

HKCUの32/64ビューに同じ登録が見える。これを別個の2インストールとは数えない。初回の限定的な登録検索で取得できなかったことは登録不存在の証拠にしていない。

## インストール済みexeの確認とデータ保全

```powershell
$env:PATH = (Join-Path $PWD '.tools/node_modules/.bin') + ';' + $env:PATH
$env:XHARNESS_TEST_EXECUTABLE = 'C:\Users\ahwri\AppData\Local\Programs\XHarness\XHarness.exe'
.\scripts\pnpm.ps1 exec playwright test smoke.spec.ts --output=.out/installed-update-gui
Remove-Item Env:XHARNESS_TEST_EXECUTABLE
```

2件合格、2.4秒。実際のインストール先exeを `--fake` で起動し、専用の新規一時 `XHARNESS_HOME` / Electron userData / sessionData、`isPackaged=true`、実行ファイルの絶対パスをfixtureで検証した。初期画面、fake ping/pong、タブ切り替えが成功した。テスト用アプリは通常終了し、検証後に XHarness プロセスが残っていない。

既存 `~/.xharness/sessions` の会話JSONL4件、使用量記録4件、index1件の合計9ファイルは、更新前に採ったSHA256と更新後・fake検証後の値が全件一致した。既存checkout `D:\AIwork\Xharness` は `50e7707c0704e1d5aea5818cdea4bae8a2ef7599` のままclean。既存ユーザーデータの削除はしていない。

認証情報の読み取りや実通信を避けるため、**既存の通常プロファイルを新バージョンで起動する確認は未実施**。既存履歴が新UIに表示されること、通常プロファイルの全設定の意味が保持されること、認証・接続状態までは保証しない。既存設定の内容も読み取り・コピー・変更していない。利用者は更新済みの通常ショートカットから起動できる。fake確認を通常プロファイルの移行確認とは扱わない。

証跡は `.out/installed-update-audit.json`、`.out/installed-update-session-baseline.json`、`.out/installed-update-gui`、`.out/install-update-state.png`、セットアップ画面の画像。ローカル証跡には通常データのメタデータや画面が含まれるためGitに追加しない。今回の変更は記録のみで、全1620件・全配布GUI21件・lint/typecheck/buildの既存成功記録は前段の検証資料を参照し、再実行したとは記載しない。実AI通信・認証CLI・push・mergeは実施していない。

更新失敗時の候補として旧本体退避は残す。ただし復旧作業は未実施で、登録まで含む自動ロールバックの保証ではない。通常アプリを閉じてから本体・登録を復旧し、ユーザーデータを削除しない方針とする。
