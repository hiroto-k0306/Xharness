> 過去の記録：移動元 `docs/runtime-materials-merge-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# ランタイム更新・紹介資料のマージ確認（2026-10-08）

ユーザーの「レシート出力も紹介フォルダに入れてマージして」に基づく公開準備。作業ブランチは`codex/loopflow-workflow-ui`、開始HEADは`27262a3bea4ff0840604a23036a1534b5345c90d`、fetch後のmainは`c780b9e1cb1fa2087e064094907c5d10ead701f6`。mainはHEADの祖先で取り込み競合なし。既存のLoopFlow・起動エラー分類・ランタイム更新・紹介資料の変更をまとめ、用途ごとの小さなコミットへ分ける。

## 追加した出力

[紹介フォルダーのレシート一覧](../presentations/20261008/receipts/README.md)に、保存済み合成セッションbfedb00eのレシートHTML1件とworkflow HTML5件を追加。既存のread-only exportExecutionReportを呼び、履歴や資格情報は変更しない。詳細workflowは原本をコピーしている。実AI通信・認証更新・ログインはこのマージ準備では0回。

通常workflowの会話レシートは5件（OfficialWorkflow 4件、撮影時のLocalBrowserStop 1件）。モデル入出力の全内部往復を記録するものではない。実装・レビューなどの詳細はworkflow HTMLへ分離されているため、READMEに読む順と限界を記載した。実案件・未承認の利用者履歴は含めない。

出力形式を保持するため、レシートHTMLのみPrettier除外に追加。PowerPoint用HTMLプレビューは通常どおり整形し、画像や内容を変えない。

## 最終差分の確認

- Windows、Node 24.16.0で関連17ファイル**202テスト成功**。今回181件と追加のLoopFlow/通常公式セッション/App 21件を重複なしで実行。fake・mock・fixture・一時ファイルのみ。全リポジトリ回帰は実行していない。
- 型チェック、全体lint、整形チェック、通常build、headless build、git diff --check成功。HTMLプレビューの未整形を検出し、整形後に再確認。
- Edge headlessでレシート/詳細HTML6件の描画とページエラー0件、レシート5件と折りたたみ操作を確認。外部画像・iframe・scriptなし。トークン形式・資格情報項目・思考本文の混入検査を通過。元の実通信内容は[実通信報告](../workflow/report/codex-prerelease-live-20261008.md)に記載。
- PowerPoint7枚とHTMLプレビューの描画/操作は前作業で検証済み。今回はレシート追加とHTML整形後の表示・リンクを確認。PowerPoint本体での描画、全GUI回帰、portable/recoveryは再実行していない。
- ローカル`.github/workflows`なし。公開後のGitHub checks/statusを別途確認する。
- 記録: `.out/merge-runtime-materials-20261008/`。生成exe、SDK配布本体、隔離home、raw履歴・資格情報はステージしない。PPTX・HTMLのみ紹介資料として含める。

## 継続する制限

現在の通常workflowから結果受け渡しは利用不可。旧経路の枠待ち自動再開・子エージェントの素材を現在の通常workflow成功例として扱わない。レビュー指摘0件のため今回の実通信で修正サイクルは未検証。SDK更新後のAPI意味互換性、翌日の更新、Codexアプリ更新後の追従、固定解除と異常終了復旧も未確認。これらはPR本文に明記する。

## コミット後の対応

実通信済み配布物のコードは今回の `c1287d2`（package: 管理SDKの初期化用依存を同梱）までのソースに対応する。その後は紹介資料・レシート・記録だけの変更。整形後の紹介HTML SHA256は `486F582CF6E9AFA2AD18B8E449E376B326AF1434BB0D9B4E2CA7E8B8867E2F93`（画像・文章の変更なし）。整形後も7枚decode・ページ移動・390px幅・ページエラー0件を確認。PPTXは `BC6769F794002EF67EDFE785C28D7E81D501F3871A4816FE3A16CBDDCC96FEB6` のまま。

コミット前ごとにstaged diffと禁止ファイル・秘密値パターンを確認し、全コミットを目的ごとに400行以内へ分割。生成exeや生のJSONLを追加せず、合成課題のHTMLだけを公開対象にした。GitHubのPR・マージSHA・CI結果は完了報告で示す。
