# 限定Computer Use土台（第6項）

基点 `d634fdb`、専用ブランチ `feature/local-computer-use`。現行仕様は [SPEC.md](../SPEC.md) §10。これは内蔵ローカルカウンターページに限定した、観測→単一操作の明示確認→receipt→停止の土台。Computer Use完成版、任意サイト、PC全体やモデルによる自律操作には対応していない。

## 利用者の操作

projectの会話で「ローカル操作の土台」を開く。「隔離fixtureを観測」は内蔵固定ページを新しい専用profileで開く。既に観測中の場合は同じページを再観測する。画像、論理URL `local-fixture:counter-v1`、タブ/document、観測世代、image/frame hash、固定ボタンの矩形とcountを表示する。

「この観測の単一操作を確認」で許可待ちになる。対象を確認し、checkboxの後「単一操作を明示実行」。固定DOMボタン `increment` を1回クリックしてカウンター結果を取得し、ブラウザを閉じ、receiptと最終記録を保存して停止する。画像の座標はCSS pxの対象矩形であり、任意座標を受け付ける操作APIではない。確認とDOMクリックを同じrenderer evaluation内で行い、座標確認と実行の間に別要素へ差し替わる操作を避ける。

「停止・取消」、閉じる、通常の停止/`/stop`、会話を閉じる/削除、renderer再読込、アプリ終了で確認票を無効にし専用ブラウザを閉じる。通常のモデル依頼を開始する場合も観測/確認票を停止する。成功後に再度観測すると新しいprofileのカウンター0から始まる。前の操作IDは再利用しない。

状態は観測済み・許可待ち・実行中・停止・結果不明を区別する。結果不明は既存receiptと操作記録を確認し、新しい会話を使用する。その会話での再実行・自動復旧・自動再開はしない。

## profileと権限の境界

既存Electronの `session.fromPartition('local-browser-<uuid>')` を使う非永続の専用メモリ内profile。`persist:`、既定session、通常のユーザープロファイル、既存ログイン/Cookie/認証情報は使用・コピーしない。終了時に当該windowをdestroyし専用storageをclearする。内蔵HTMLをdata documentとして読み込み、利用者のURL・HTML・selector・JavaScriptを受け付けない。Node/preload/webview/DevToolsは無効、sandbox/contextIsolation/webSecurityを有効のまま使う。

このprofileのwebRequestは内蔵data URLの完全一致以外を拒否する。CSPでconnect/frame/worker/resource/form/baseを禁止し、追加window・遷移/redirect・download・permission request/checkを拒否する。spellcheckのdownloadを無効にし、WebRTCは非proxy UDPを禁止する。page内の実行コードはchecked-in counter fixtureだけであり、任意ページのコードを実行するサンドボックスではない。upload、clipboard、キー入力、OS入力、他アプリ/既存window操作は公開しない。セキュリティ設定を緩和せず、追加ソフトや依存は不要。

`LocalBrowserObserve` / `LocalBrowserClick` は既存permissionsのdenyを確認する。readOnly/planでは観測できてもクリックを拒否する。allow/acceptEditsでも単一操作の明示checkboxを省略せず、永続的なツール許可は作らない。画像・ページ内命令・過去のreceiptは権限付与ではない。モデルツールに登録せず、観測画像やページを通常の会話/モデルリクエストへ自動追加しない。headlessには実ブラウザadapterがなく、勝手に代替ブラウザを起動しない。

## 保存・世代・停止

同homeの既存writerを利用する。操作前に `local-browser/<sessionId>.json` へpending intentをsync→renameで保存し、既存ReceiptStoreへ今回限りの確認と開始をdurable appendする。その保存が成功するまでクリックしない。receiptは既存UI/HTMLレポートで確認できる。観測・許可待ち・明示許可・開始・取得結果・停止を区別し、画像本体はreceiptや会話へ保存しない。

タブ/document/論理URL、観測UUID/世代、DOM frame hash、PNG bytes SHA256、対象矩形/label、確認UUID/60秒期限を結ぶ。再観測で古い世代は使えない。prepare/confirmで再観測し、intent/receipt保存後にもadapter内でDOMとURLを原子的に再検査する。document tokenとnavigation generationにより同じURLへのreloadも拒否する。ユーザー入力で別タブへ切り替える経路はない。

各commandは会話の既存session leaseを取得し、同時モデル実行・二重クリック・削除・権限変更・project解除を拒否する。停止はlease中も利用できる。操作後にブラウザ停止、結果receipt、最終JSON保存が確定してから成功と表示する。タイムアウト/中断/保存障害で効果が不明ならunknownを保持し、再実行しない。pendingが残る再起動でも未知として表示するだけで、adapterや操作を復元しない。既知の同じ操作IDを再確認してもクリックしない。

台帳は会話作成時刻・project実体/cwdと結び、home/ディレクトリ別名・壊れた記録・境界変更でfail closed。会話ごと100操作・256,000 UTF-8 bytes、観測PNG2,000,000 bytesの上限。結果不明の解除・台帳整理・画像の永続保存は未対応。

## 検証と安全な次の実証

Windowsでは `pnpm` を `.\scripts\pnpm.ps1` に読み替える。

```powershell
.\scripts\pnpm.ps1 test src/main/computer-use/session.test.ts src/main/computer-use/boundaries.test.ts src/main/local-browser-electron.test.ts
.\scripts\pnpm.ps1 test:gui
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 build:headless
```

fake adapterで状態・期限・タブ/DOM変更・保存fault・停止・タイムアウト・再起動を検査。Electron mockで外部URL、file、任意data document、download、追加window、permissionsの拒否を検査し、実ネットワークを発生させない。GUIは `--fake`（モデル通信なし）で実Electronの専用profileと内蔵ローカルページだけを使用し、観測画像・カウンター1回・Cookie非共有・非永続性・DOM/reload失効・結果不明UIを確認する。詳細は [検証記録](local-computer-use-validation-20261005.md)。

次の実証もローカルに限定する。まず同じfake transportでframe変更直前/直後、停止とstorage失敗の組合せを増やす。次に隔離した第二の内蔵fixtureで別layoutと遷移を試し、URL/viewport/targetの確認票を再取得する境界を検証する。画像で判断するモデル連携、汎用pointer/key/scroll、外部サイト、download/upload、ログインや実環境操作は別の明示依頼と対象許可が必要で、今回の成功から安全性を推定しない。

## 制約

効果は内蔵ボタンのDOMクリックであり、実際のマウス座標入力ではない。WebRTC等も含め、任意の悪意あるページに対する完全なブラウザネットワーク隔離を証明したものではない。通常profileの秘密を扱う必要がない固定ページで境界を確認した限定実装。複数ファイルACID、電源断の完全耐久性、非協調の外部編集は保証しない。既存receiptは結果取得の根拠であり、一般タスクの品質/テスト合格・サブスク枠の根拠ではない。
