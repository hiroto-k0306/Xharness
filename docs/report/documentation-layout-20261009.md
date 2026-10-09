# 文書階層の再構成と整合性確認（2026-10-09）

## 対象と実施範囲

基準コードは `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。保存済みクラウドLinux checkoutで文書を整理しました。最新remoteをfetchし、origin/mainは `f7f7350e426185078aa6869f802024d9b59c5be8`（PR #28のmerge）でした。今回の対象はその後のローカル作業を含む基準コードです。PR #25の成功報告だけを正とせず、現在の定義・登録・呼出・UI/headless・保存処理・既存test定義と照合しました。

実モデル通信、Windows GUI/配布物の再実行、インストール、全回帰、ACL/認証変更は行っていません。作者設定は変更せず、push/mergeも行いません。過去のWindows・実アプリ障害修正結果はreportの当時の環境/revisionの証拠として残しています。

## 配置と更新責任

全体・横断事項は [Requirements](../Requirements.md)、[Spec](../Spec.md)、[Architecture](../design/Architecture.md)。機能はworkflow / sessions / skillsの3群です。各群にRequirements、Spec、design、reportを置きました。現在の責務境界では独立サブシステム層を増やす必要がなく、小さな設定ごとの3層分割を避けています。[文書索引](../README.md)が入口です。

Requirementsは背景・目的・利用者ニーズ・前提・NFR概要のWhy。Specは検証可能な要件、具体的なAPI/画面/状態/振る舞い、受入条件を分離したWhat。designはHow、reportは時点の実装/検証/障害記録です。root READMEは概要・ナビ、AGENTSは憲章・原則・スコープ・ガバナンスへ整理しました。root SPEC/DESIGN/FEATURESは短い移転案内です。

AGENTSの完了条件は、コード・tool定義/登録/呼出/振る舞いの変更時に要求・仕様・設計・受入・検証記録・リンクへの影響を確認し、関係する文書を更新することです。不要な場合は理由を記録し、無関係な全ファイルの形式的な更新を求めません。

## 旧資料と保持対象

基準のtracked docs 218件を[棚卸し](documentation-layout-20261009/inventory.tsv)しました。混在した旧設計22件とroot文書5件は[原本保存庫](../../Old/doc-layout-0e5fa40/INDEX.md)へbyte単位で保存しました。歴史的report128件とmanifest4件は機能/globalのreportへ移動し、原本の時点・環境を明示しました。Markdown本文の相対リンクと整形を調整しましたが、過去の試験結果を新しい結果へ変更していません。gui-testingの過去実測は別の[2026-10-04記録](gui-testing-20261004.md)へ抽出し、現行smokeの範囲を開発案内で訂正しました。

[移動・保存対応159件](documentation-layout-20261009/moves.tsv)はsource、action、保存先、正本入口、source SHA256/sizeを持ちます。旧資料・保全資産から必要な旧path参照は[互換案内](documentation-layout-20261009/compatibility-stubs.tsv)で残しました。旧仕様本文を現役正本として複製していません。既存Old213件はREADMEへの索引追記以外改変せず、README旧本文も完全なprefixとして保持しました。

例/test fixture、紹介資料、検証ログなど64件は位置・bytesを保持しました。`src/main/hooks/examples.test.ts`が読むdocs/examples、現役配布README、資源、ユーザーデータを整理対象にしていません。歴史manifestの記録内のpathはその時点の事実なので書き換えていません。

## 整合性と不一致

workflow・sessions・skills文書は独立担当が作成し、別担当がコードと文書を読取照合しました。共有索引・移動・リンクは統合担当が編集しました。[指摘一覧](documentation-layout-20261009/mismatches.tsv)には旧版の食い違いと新文書レビューの指摘を残しています。

- 廃止済み手動改善UIを現役とする旧FEATURES、native DAGを常時無効とする旧SPECを正本から除外しました。条件付きruntime gate、普通の直列作業との適用差、対象Windowsでの未確認を分けています。
- 通常tools登録0と公式native tools、内部helper/手動IPC、verificationOnly fixtureを分けました。通常枠不明STOP、phase別ツール/sandbox、catalogの無効モデルと過去verified記録、alias/policyと保存IDの照合を仕様へ戻しました。
- 通常会話の原文長1〜4000と専用IPCのtrim後1〜4000は入口が異なります。承認期限も「画面を見た時刻」ではなく、計画要求生成/操作queue先頭昇格のサーバー時刻を起点とする仕様へ訂正しました。
- モデル別実績入力はコード上実装済みですが、LLMの担当選択改善は未実証です。Codex選択skillは隔離未確認でSTOP、Claude選択bundleは実装と対象実通信成功を分けています。
- 別途製品修正候補：`OfficialWorkflowReceipts.tsx`のsummary内のp要素はHTMLの内容モデルに合いません。準備操作buttonの操作/アクセシビリティも対象実機で未確認です。今回の文書整理では製品修正を行っていません。

## 限定検証

[リンク・原本・資産確認](documentation-layout-20261009/checks.json)と[コード参照確認](documentation-layout-20261009/code-reference-check.json)が証拠です。current文書と移動reportの相対リンクを、code例を除外して実在/case照合し、正本のfragmentも照合しました。保存原本27件と歴史TSV4件はgit基準blobと一致、既存Oldと64資産も保全確認しました。

10ファイルのsource/script/build変更は文書参照commentのみです。TypeScriptはcommentを除いたAST出力、builderはYAML値、CSSはcommentを除いたrulesの同一性を検査しました。動作・tool定義/登録・テスト内容は変更していないため、機能テストの再実行は不要と判断しました。変更対象のPrettierとgit diff --checkも確認しました。全回帰や過去の117件等を今回の成功数へ再計上していません。

残る未確認は、対象Windowsの隔離・プロセス終了、最新配布物/インストール、実モデル通信、Codex選択skillの隔離、feedbackの実際の改善効果です。今回の整合性確認はそれらの実行証明ではありません。
