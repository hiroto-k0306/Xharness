# 第6項・限定Computer Use土台の検証（2026-10-05）

基点 `d634fdb53190de51f99dc06796f83d36c1b6df52`、専用ブランチ `feature/local-computer-use`、検証コード `de38e5a`。現行仕様はSPEC.md §10。任意Computer Use完成版ではなく、内蔵カウンターページの観測→明示単一DOM操作→receipt→停止を実装した。

## 実施した範囲

- fake adapterで状態/nonce/期限/タブ/document/世代/DOM変更、intent/receipt/final保存fault、二重操作、停止/タイムアウト、pending再起動と再実行拒否を検査。
- Electron mockで専用非永続partition、sandbox/Nodeなし/webSecurity維持、外部URL/file/任意data document、download、追加window、permissions拒否を検査。mock callbackの評価だけで実ネットワークを発生させていない。
- **実Electron 44.5.1のブラウザ**でも、専用非永続profileと内蔵data documentの固定ページで観測画像とカウンター1クリックを検証した。これはmockのみの動作確認ではない。モデルは `--fake`、画像送信・プロバイダ呼出はない。
- 実ブラウザの既定test-app profileへダミーCookieを置き、新profileのcookies空/非共有/非永続/580×360 CSS px/zoom1を確認。通常ユーザーのCookieや資格情報は触っていない。
- 確認後のDOM変更と同URLのreloadでクリックを拒否。成功時は専用windowが閉じ、count1の結果receipt/JSONと会話JSONLなしを確認。renderer再読込で記録が残ること、fault fixtureでpendingを作り結果不明表示・観測禁止・同ID再実行拒否を確認。

## 環境と保全

Windows、Node 22.23.3（ローカルpnpm runnerのPATH）、pnpm 10.34.6、PowerShell 7.6.5（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。整形用の直接Nodeは既存system Node 24.16.0を使ったが、Node24の全試験を実施した意味ではない。Electronは既存44.5.1を使用。追加install・依存/lockfile変更・セキュリティ設定の緩和なし。

独立clone `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness` で作業。元作業領域 `D:/AIwork/Xharness` と既存の `feature/task-handoff` (`d634fdb`)・`feature/model-candidates` (`29bf0c0`)・`feat/task-evaluation` (`678cf9d`)を保全した。push/mergeは行わない。AGENTS.md・SPEC.md・既存test手順を確認し、`.agents/skills`は存在しなかった。DESIGN.mdやPCメモリを現行仕様として扱わない。

## 検証結果

固定コード `de38e5a` の最終全Vitest回帰は **179ファイル・1618件成功（284.39秒）**。上記のfake/mock 11件と既存の評価/provider usage/workflow/履歴/メモリ/受け渡し/候補/quota/保存整合性を含む。全回帰開始後の差分は仕様・操作・検証文書だけで、古い成功を最終コードの結果へ転用していない。

| 検査                                       | 結果                          |
| ------------------------------------------ | ----------------------------- |
| 関連fake/mock Vitest（最終停止順序修正後） | 3ファイル・11件成功（4.76秒） |
| typecheck / lint / format:check            | すべて成功                    |
| desktop / headless build                   | 両方成功                      |
| 実Electron・ローカルfixtureの単独GUI       | 2件成功（4.4秒）              |
| 最終全Electron --fake UI                   | 19件成功（35.2秒）            |
| git diff --check                           | 成功                          |

全UIには以前の評価・受け渡し・履歴・メモリ・改善版・モデル候補・skills・quota・保存整合性も含む。最終コードのComputer Useの2件は、成功後のprofile停止・保存とDOM/reload失効・結果不明の状態を検査した。

`.out/gui/local-browser-real-isolate-59f5d-d-stops-without-model-calls/` の `local-browser-observation.png`、`local-browser-stopped.png`、`local-browser-unknown.png` を保存。観測画像では実ローカルfixtureのcount0と固定ボタン、URL/タブ/世代/矩形/画像hashを表示する。観測と結果不明のスクリーンショットを目視確認し、未信頼画像・対象・再実行禁止・制約を表示できた。Git対象外。

途中の型検査でfake adapterのdocument ID/array型、確認actionの判別、Receiptのdecision型、ElectronのWebRTC API位置を既存型へ合わせた。mockの不要引数を修正してlintを成功させた。lint抑制・追加依存・実プロバイダ通信での代替検証は行っていない。最終全回帰を開始した後はコードを変更せず、文書のみ追加した。

## 未実行・残る制約

実Claude/Codex/ChatGPT通信・モデルへの画像送信・認証CLI・サブスク枠・外部サイト/接続・download/upload・PC全体/通常ブラウザ操作・ソフト導入は未実行。開発検証は隔離 `--fake` homeだけ。OS killや電源断を行わず、mock保存faultと専用homeのpending fixtureで境界を再現した。exe/インストーラー、WindowsApps/Store版pwsh、Node24の全回帰は未実行。

固定DOMボタンの1クリックであり、汎用画面座標入力やモデル制御ではない。限定ページでの保証を任意の悪意あるページ・完全ネットワーク隔離・外部副作用のexactly-onceへ拡張しない。結果不明は新会話へ進む。100操作/会話・256,000 bytes、PNG2,000,000 bytesの上限、既存writer/保存整合性の限界を維持する。

操作説明・制約・次の安全なローカル実証手順: [local-computer-use.md](local-computer-use.md)。
