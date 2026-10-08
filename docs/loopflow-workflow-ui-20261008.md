# 通常ワークフローのLoopFlow表示

## 対象と変更

2026-10-08、main c780b9eからcodex/loopflow-workflow-uiで修正。実装コミットは61403a6。ユーザーの「まずLoopFlowのUIを修正」の指示に基づき、SPEC.md §10へ表示仕様を追記した。実行・承認・接続方式は変更していない。

通常desktopでは旧6 STEPタブを表示せず、同じsessionIdの最新保存workflow記録から、判別・回答、対象確認、計画、計画承認、実装・修正、独立テスト、別会社レビューを表示する。モデルの要求先を会社別の色で示し、公式基盤のツールイベントと、ハーネスのテスト・Git・保存記録を分ける。上部に現在の工程と終了状態を表示。従来のLoopFlowは旧実行経路に残した。

既存のofficialWorkflow listは読取専用。表示中に500ms間隔で直列取得し、前回の取得が終わるまで次を開始しない。広い画面では常時表示、1099px以下ではLoopFlowタブ表示中のみ取得する。会話変更・非表示・unmount後の遅延応答を反映しない。新しい送信準備中に以前の完了を表示せず、取得失敗を完了や許可へ読み替えない。質問で実行されていない計画・実装・テストは未記録と表示する。

## オフライン確認

- 環境: Windows、Node 24.16.0（C:/Program Files/nodejs/node.exe）、PowerShell 7.6.5（Codex同梱のC:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe）。Store版pwshの確認ではない。scripts/pnpm.ps1を使用。
- 関連7ファイル103テスト成功。WorkflowFlow、Activity、workflow-ui、App.official、session/official-session、official/service、official/runtimeを対象とした。最終の要求先表記・上部工程表示・画面幅対応後にrenderer4ファイル25テストを再実行し成功（103件の部分集合で、追加25件ではない）。
- 新規7テスト: 独立テストと公式ツールの区別、質問の未実行工程、作業対象確認待ち、修正担当と個別操作承認待ち、他セッション/旧完了の不採用、取得の重複防止・遅延応答・unmount、非表示/取得失敗。Appに通常経路の切替と旧STEP非表示のテストも追加。
- 初回に対象確認待ちの強調が失敗したため、判別完了と利用者の対象確認待ちを分けて修正。再実行成功。
- 最終コードのtypecheck、lint、通常build成功。変更したTSX/CSSのPrettier確認とgit diff --check成功。
- ビルド済みrendererをローカルHTTP経由でEdge headlessへ読み込み、模擬IPCだけで1280px/900pxの表示を確認。現在工程・ツール状態の表示、狭い画面でのタブ切替、ページエラー0件、横はみ出しなし。保存画像は.out/loopflow-ui/desktop.pngとnarrow.png。初回の静的配信でSVGのMIME指定がなくロゴが表示されなかったため、配信側を修正して再撮影した。製品コードのロゴ変更はしていない。

## 制限・未確認

保存される工程・呼出要求・結果を表示し、公式SDK/App Server内部の全往復や送信バイト列を推測しない。要求先は指定モデルであり、観測された応答モデルへの読み替えではない。ツール欄は直近6イベント。既存listの最新20workflowに含まれない古い会話は記録未取得表示となる。新しい保存形式や権限付与、専用パネルの削除は今回行っていない。

実モデル通信・認証・Electron起動・配布exe作成/起動・上書きインストール・全回帰・push・mergeは実施していない。実SDK/App Serverで進行する実アプリの手動確認は未実施。紹介PPTX/HTMLも今回は変更していない。
