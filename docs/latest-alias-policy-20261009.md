# 最新aliasによるモデル選択（2026-10-09）

基準mainはf7f7350。利用者の「基本的に最新モデルを使う」「進行中の再開もaliasベース」という新しい仕様に従い、以前の完全ID固定方針を変更した。今回の変更はローカルコミットまで。全回帰・実モデル通信・Windows GUI/配布・インストール・ACL/認証変更は実施しない。

## 選択と記録

既定設定と新規会話の選択は世代なしalias、effortは独立項目として保持する。開始・安全な保存状態からの再開・次の通信直前に現在のcatalogを読み、aliasを完全IDへ解決して公式一覧/通常枠/effortを照合する。単一通信の解決結果は固定し、その最中のcatalogやUI選択変更は次の呼出から適用する。別モデル・別effortへの暗黙fallbackはない。

過去のplan/planner/callsの実ID・effort・catalog、承認digest、scope、checkpointは書換えない。追従方針はmodelPolicies、新しいcallの解決先・catalog・前回との差はmodelSelectionへ保存する。GUI・HTML・headlessで保存した解決証跡を表示し、旧記録の欠測を現在catalogから補わない。モデル選択方針はファイル/操作承認の代わりにならない。別会社レビュー、不確かな副作用を伴うresume拒否、二重操作の防止、無断再送禁止を維持する。

完全IDからaliasへの移行にはcatalogのid/acceptedIds/historicalIdsの明示対応が必要。名前や世代番号を推測しない。新catalogでは過去IDとのfamily対応をhistoricalIdsに維持する。未定義・競合・family/provider/effort不整合・利用不可なら理由付き停止し、履歴閲覧は拒否しない。未知の旧完全IDを自動実行するのではなく、選択確認を必要とする。native providerセッションの自動継承は実装せず、従来の安全な保存状態から独立した公式呼出を使う。

headless --resumeは無関係な既定モデル/effortの検証で保存会話を開けなくしない。旧会話は閲覧専用、公式会話は当該保存選択を送信時に確認する。report/replayはモデルを起動しない。新規作成は無効選択を停止する。

## 限定確認

Linux、Node24.19.0、既存node_modules。関連検証は以下のとおり。独立担当の重複実行数を加算して全体成功数にしない。

| 範囲                                            | 結果                                                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| catalog/configと毎読込                          | 5ファイル40成功。mockfsで内容更新、破損更新、ENOENT/EACCES、競合と出典不変を確認                                 |
| controller/official-session/headless/旧設定契約 | 4ファイル53成功。旧期待値をalias保存へ更新し、旧履歴の完全ID保持を確認                                           |
| 新alias controller/headless                     | 2ファイル10成功。更新後の次回解決、通信中固定、無効選択停止、履歴不変、既定無効でもresume閲覧                    |
| GUI                                             | picker/helper10成功、App17成功、workflow表示24成功（重複を含む）。保存証跡と欠測を表示し先頭候補への暗黙変更なし |
| HTML                                            | 4成功。新証跡/旧欠測/escaping/原record不変                                                                       |
| official core                                   | 3ファイル66成功。最新解決、複数call、再開、歴史不変、effort/availability、sidecar不整合、途中の理由付き停止      |

関連runtime/planner-choiceのLinux実行は33件中23成功・10失敗。同じ対象を基準f7f7350のarchiveでも実行し、23成功・10失敗と完全な失敗ケース名が一致した。Windows owned-process依存を今回の新しいモデル不具合と扱わない。[PR27のWindows確認](windows-pr26-validation-20261009.md)はfce9ebaで限定48成功という別記録であり、今回alias変更をWindowsで再実行した証明ではない。

最終統合後、型・全体ESLint・変更ファイルPrettier・差分検査が成功。headless表示追記後の3ファイル27件も成功（既存の53件/新10件と重複）。現行変更文書の内部リンク181件を確認。

正規文書6件の更新前版をOldへバイト一致で保存。現行文書のリンク・型・lint・整形・差分、原本ハッシュを確認する。独立レビューでは呼出前解決、同family/effort整合、plan/digest不変、具体停止理由を確認した。

改善機能の8000/4000文字制限、モデル評価の集計/計画への還元、公式スキル連携は別件。このコミットでは改善機能を変更しない。公式スキルの追加は後続の別コミットで扱う。
