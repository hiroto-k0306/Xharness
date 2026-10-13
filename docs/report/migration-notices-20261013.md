# 移管済み移転案内の整理（2026-10-13）

## 対象と方針

remote mainを照会・fetchし、基準は `42155341d9b8dc4aadf4c36083141e73aa0c1796` と再確認しました。既存 `D:/AIwork/Xharness` は `2190398`、作業ツリーはcleanでした。元checkout・既存worktreeを変更せず、独立cloneの `docs/archive-migrated-notices` で整理しました。dragon-deckにはアクセスしていません。

ユーザー指定は、移管済みで移転案内のみの文書をOldへ保管し、元の場所に同じ案内を残さないことです。AGENTSは憲章、READMEは案内、RequirementsはWhy、SpecはWhat、designはHow、reportは時点記録という責任分担を維持します。基準AGENTS・全体Requirements/Spec/designと関係するsessions Specを確認しました。repository内に追加AGENTSや `.agents/skills`、`.codex` はありません。PC memoriesは不要でした。

## 移動・参照更新

案内文の全本文と移転先の実在を確認した69件（docs直下66件、root SPEC/DESIGN/FEATURES 3件）を [Old保存庫](../../Old/migration-notices-4215534/INDEX.md) に移動しました。各原本はbytesを変えず保存し、既存の旧本文・reportを複製・削除していません。[移動一覧](migration-notices-20261013/moves.tsv) はsource、保存先、直接参照先、SHA256、sizeを持ちます。

[参照修正一覧](migration-notices-20261013/references.tsv) に、Old索引、紹介資料/receiptsのREADME、sessions Requirements/design、憲章・索引・全体Spec、examplesの案内、ビルド設定comment、Prettier除外を記録しました。ローカル観測は旧案内のworkflow入口ではなく、実際の手動操作契約を持つsessions Spec §6へ直接つなぎました。スクリプト・テストの実在文書参照も検索し、テスト期待値の変更は不要と確認しました。`docs/a.md` 等は任意pathのfixture入力で、今回移動する資料ではありません。

現行ナビには既存のOld索引入口を使い、69件の案内を現行索引へ並べ直していません。AGENTSの旧stub維持記述とSpecの受入条件SYS-A03を直接参照方針へ更新しました。Why/Whatの製品内容やAPI、ツールの定義/登録/呼出/振る舞いは変更していません。

## 保全対象と例外

- 全体/機能別Requirements・Spec・design、開発手順、過去reportは固有本文を持つため現行配置を維持しました。
- examples設定/command/HTML、紹介資料のPDF/PPTX/HTML、検証ログ、spike、release、資源、利用者データは移動・書換していません。examplesのREADMEは旧DESIGN参照を保存原本と現行Specへ接続する文書変更だけです。
- 既存Oldの保存原本は変更していません。Old/READMEは入口なので、5リンクの現行配置への更新と今回の保存庫入口追加を行いました。
- 保存した案内文と既存Old原本内の相対リンクは出典時点の配置を表すため、byte保全を優先して書き換えていません。保存庫INDEXの対応表から有効な資料を開けます。
- 過去reportの旧文書名・章番号、歴史TSV/JSONの旧path・過去の検査期待数は時点記録として維持しました。今回の移動を過去に実施したことにはせず、新しい対応表と検査結果で補います。旧pathを指定した外部bookmark/任意memoryFiles設定は調査対象外で、案内stubを再設置しません。

## 検証と限界

[検査結果](migration-notices-20261013/checks.json) に、69件の原本hash一致・元path不在・直接参照先実在、既存Old原本/過去report/保全資産の一致、現行Markdown相対リンクの実在とcase、現行正本fragment、削除pathへの現役固定参照、製品/テスト変更範囲を記録しました。旧本文内のリンクは上記例外で、現行リンク成功数には含めません。

69件の保存原本一致・元path不在、既存Old原本239件、過去report/証拠183件、保全資産120件の一致を確認しました。Markdown162件の相対リンク1,050件と現行正本fragment4件はエラー0、削除pathへの現行リンクと残存案内文書も0件でした。

Windows、Node `v24.16.0`（`C:/Program Files/nodejs/node.exe`）、PowerShell `7.6.5`（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）、Python `3.12` で文書検査を実施しました。既存依存のPrettierで変更Markdown/ビルド設定を確認し、git diff --checkも確認しました。依存install、lockfile変更、永続作者設定変更は行いません。

製品ソース・テスト・設定値は未変更で、electron.vite.config.tsは文書commentだけです。機能テスト/全回帰/型検査/build/GUI/実モデル/配布再検証は今回の文書整理の証拠として実施していません。過去の成功数を今回の成功へ再計上しません。push/mergeは行いません。
