# Receipts準備中のsummary構造修正（2026-10-09）

## 対象と再現条件

開始HEADは `5d4c90faa0e0023d6c3ef550992936a8229e98db`。文書再構成で記録したDOC-010を、今回のチャット中心・既定折りたたみUIの直接の不具合として調査・最小修正しました。

`OfficialWorkflowReceipts`の当時54〜72行は、`activeId`があり、`activeSessionId`が表示会話に一致し、そのIDの保存recordがまだない場合に、準備状態のpと中断buttonをsummaryの件数括弧の中へ挿入していました。外側Receiptsを手動で開き、内側の公式証跡detailsを閉じた状態でも再現します。保存recordがある通常表示や、別会話ではこの準備ブロックは表示されません。

[HTML Standardのsummary内容モデル](https://html.spec.whatwg.org/multipage/interactive-elements.html#the-summary-element)はphrasing contentとheading contentを認めますが、pは適合しません。button自体を不正なphrasing contentとする判断はしていません。

## 観測した影響

Linux上の実Chromium `151.0.7922.173`で、実ReactコンポーネントをローカルHTTPの模擬preload APIへ接続して修正前後を確認しました。Electron/Windows実機・実SDK・実モデルの再実行ではありません。

修正前のsummaryは準備段落で複数行に分断され、件数の閉じ括弧が別行に離れていました。Chromium Accessibility treeのDisclosureTriangle名にも、証跡見出しに加え、準備状態文と「接続確認を中断」が含まれていました。これが実際に確認した表示・意味論上の影響です。

このChromiumでは、修正前も中断クリックとsummaryのEnter/Space開閉は機能していました。中断が必ず開閉を起こす、取消できない、ブラウザーがDOMを破壊するとは結論していません。スクリーンリーダー本体・別browserの挙動は未確認です。

[修正前の観測JSON](receipts-summary-structure-20261009/before.json) / [画像](receipts-summary-structure-20261009/before.png)

[修正後の観測JSON](receipts-summary-structure-20261009/after.json) / [画像](receipts-summary-structure-20261009/after.png)

## 最小修正

準備状態pと中断buttonを、Fragment内でnative detailsの前の兄弟へ移しました。summaryは見出しと同会話の件数だけです。buttonは明示的な`type="button"`です。内側detailsが閉じても準備取消は表示・操作でき、取消クリックと開閉の操作対象が別になります。

activeSessionId / activeId / 未保存record判定、送信するworkflow IDと会話ID、既存sendのpending/再送抑止、保存証跡、外側Receiptsの既定折りたたみ・手動開閉・会話切替resetを維持しました。新しいIPC・権限・承認・保存データ・機能は追加していません。

[会話Spec](../Spec.md)のReceipts節と[設計](../design/Architecture.md)を更新しました。WhyのRequirements・全体Spec・workflow/skillsの要件は、利用者ニーズや共通契約が変わらないため更新不要です。旧版・旧監査記録は時点の事実として改変せず、この報告でDOC-010の解決を記録します。

## 限定検証

- [関連3ファイル17テスト成功](receipts-summary-structure-20261009/related-tests.log)：OfficialWorkflowReceipts、Activity、App.official。保存結果・会話所有・既定折りたたみの回帰を確認しました。
- [最終component 6テスト成功](receipts-summary-structure-20261009/final-component-test.log)：検査条件をphrasing以外のp/操作buttonがsummary内にないことへ絞った後、直接関連だけを再確認しました。17件と6件を加算した新しい成功総数にはしません。
- Chromium修正後：開閉名が証跡見出し/件数のみ、native disclosureのfocusable/expanded状態保持、Enterで開きSpaceで閉じる、中断クリック/Enterで正しいIDを各一回送信しdetailsは閉じたまま、pending中disabled・追加clickの再送なし、別会話で準備操作非表示、元会話へ戻ると閉じた状態、page errorなしを確認しました。
- 実componentのbrowser bundle生成、変更TSXのESLint、変更文書/TSX/JSONのPrettier、関連文書の相対リンクとgit diff --checkを確認しました。

Windows/Electron、実モデル、OSのスクリーンリーダー、他browser、全回帰、インストール、ACL/認証変更は実施していません。push/mergeは行いません。
