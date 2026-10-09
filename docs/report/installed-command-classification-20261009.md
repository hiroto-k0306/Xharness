> 過去の記録：移動元 `docs/installed-command-classification-20261009.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# コマンド失敗の誤分類修正版のインストール

2026-10-09、Windows 10.0.26300。ソース `40cb47dc13f706eba524b0fd50c9dd20968bb173`、ブランチfeature/native-workflow-boundary、作業ツリーcleanから作成。現行仕様SPEC §15。変更内容・関連82テストは [誤分類修正](../workflow/report/codex-command-failure-misclassification-20261009.md) を参照。

利用者のインストール依頼に従い、通常入力が空で直近workflowがfailed・実行中でないことを画面で確認し、旧アプリを通常終了した。強制終了・失敗作業の再送は行っていない。既存の配布物を上書きせず、別フォルダーへNSIS版を作成した。

- 配布先: `D:/AIwork/XHarness-release/XHarness-command-classification-40cb47d-20261009/`。electron-builder --win nsis、終了0。通常buildは同じソースで成功済み。package hookのSDK準備処理を確認して実行。
- インストール先: `C:/Users/ahwri/AppData/Local/Programs/XHarness/`。現在ユーザーへのsilent更新、終了0。
- 更新前後の設定・履歴957ファイルのSHA256一致。公式Codex connection.jsonのalpha.20固定指定も保持。資格情報の抽出・コピー・編集、ACLやsandbox方式の変更なし。
- 配布側とインストール側のexe/app.asar/SDK seed一致。SDK seedは6,522ファイル、複合SHA256 `622ba1d79e16e2703cf9644ef258c8db0dc8bc331a45bf9540c3fec15a46bb34`。
- 配布win-unpackedの隔離fake起動テスト1件成功。インストール後のexeでも隔離fake起動テスト1件成功。いずれもtest/gui/smoke.spec.ts。既存プロファイルへ接続しないことを確認するfixtureを使用。通常画面も再起動して表示確認し、そのまま残した。

SHA256:

| 対象                     | SHA256                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| XHarness-Setup-0.0.0.exe | 4bd89adfce77868173fd0270e0e4301727a49fb6290b474b48670fef56f0ac37 |
| XHarness.exe             | 6c3f7dccc6f87620074302f8c51a50cd554becd7c0a0d108165b934893c96b16 |
| app.asar                 | 98dee1723980d04496afdd1309af29db85589f90caad2514d5c60ab7168df114 |

配布先にsource-manifest.json、installed-verification.json、SHA256SUMS.txtを保存した。検証コマンドはscripts/pnpm.ps1（ローカルNode v22.23.3）。ハッシュ照合はホストNode v24.16.0。pwsh 7.6.5のCodex依存実体を使用、Store版での確認ではない。

新しい実通信・認証更新は0回。今回作成したのはNSIS版で、portable版・全GUI・全回帰は追加実行していない。Node未検出の環境差と、通常コマンド失敗後の実通信による対処完了は未確認。過去の失敗表示は保存履歴として残り、更新によって過去の結果を成功へ書き換えない。
