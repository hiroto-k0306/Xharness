> 過去の記録：移動元 `docs/model-performance-feedback-20261009.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# モデル別実績を通常計画へ渡す（2026-10-09）

利用者の追加承認により、保存済みの完了workflowから [実績集計](../../../src/main/workflow/official/model-feedback.ts) を作り、[service](../../../src/main/workflow/official/service.ts) から通常の計画LLMへ参考入力として渡します。モデル選択はLLMが行い、現在のcatalog・利用可能性・effort・別会社review等の既存制約を維持します。ハーネスによる自動ランキングや成功率score、推定所要時間を追加しません。「実績が少ない」というUI表示も設けません。

実装/fixの通信はprovider・送信時の完全モデルID・effortへ結び付け、対応する公開レビューのmust/should/nit件数、修正工程、入力/出力/cache read/cache write/reasoning/totalの既知値と欠測を記録します。aliasから過去の完全IDを現catalogで補完せず、世代をまたいで実績を付けません。未完了・模擬実行・不確定な副作用は参考実績から除外します。レビューやusageの欠測を0として成功扱いしません。要求ID/provider/effortの不一致や観測モデルの混在は担当の実績集計から除外し、usageのprovider不一致・内訳欠測はtoken欠測として残します。

新しい通信の時間はハーネスのrequest境界でwallMsと承認callback待ちの区間和を測り、重複待ちを二重減算せずactiveMsを保存します。既存elapsedMsを書き換えず、過去の承認待ちが不明ならactiveMsは欠測です。これはモデル内部のCPU時間や対象PCの資源測定ではありません。

課題のkind/difficultyはplannerの申告として保存し、観測事実と区別します。課題種別・難度・モデル世代・effortを分けて集計し、難しい課題の指摘件数だけでモデルを不利にしないようLLMへ指示します。少数標本、修正工程の従属性、reviewer差、分類欠測を内部の推論制約として渡します。旧履歴は一括移行せず、新しい完了記録にversion付き数値実績を追記します。本文・findingsの文章・rawイベント・資格情報は参考集計へコピーしません。

独立レビューで、旧履歴の欠測配列から新規計画を止める例外、観測モデルと要求モデルの不一致、usage providerの不一致、利用可能effortの候補照合を重点確認しました。未知・欠損・不一致は参考情報の欠測/除外として扱い、通常workflowの権限やモデルcatalog制約を緩めません。

手動改善版比較のUI/IPCは別機能として退役しました。既存比較DB・会話・ユーザーデータは変更せず、[旧ソース22件と入口snapshot3件](../../../Old/retired-sources/manual-improvements-bcca4826/manifest.tsv) を保存しています。参考実績を入力する実装・mock検査を、実LLMの担当選択が改善した実証と扱いません。Windows実機・実モデル通信・配布物は今回未検証です。

限定検査: 実績集計/承認待ち/旧欠測shape/モデル帰属・service保存→次計画の参照入力・既存service/runtime/native経路の直接関連6ファイル114件成功。独立読み取り再レビューで重大指摘の解消を確認しました。型・変更コードlint/format検査成功。lint修正後のservice integration 1件も再成功。実LLMの選択品質の改善やWindowsでの実行成功は未確認です。

実装コードは `df75c3b44ebd25af202ffe957db3e0ed919f6161`。参考入力は直近完了200workflow、最大1000call、60分類groupに限定します。
