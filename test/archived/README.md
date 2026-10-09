# 旧経路のGUIケース

利用者の2026-10-08の依頼により、旧HTTP／旧fakeループの応答・ツール・権限・画面構成を前提とした14ケースを保存する。削除ではなく退避であり、通常の回帰合格件数へ含めない。

対象はgui配下のconnections、evaluation、handoffs、improvements、model-candidates、project-history、project-memory、project-skills、quota-resume各1件、skills-managerの4件、smokeの旧ping/pong・旧LoopFlow切替1件。

現在の通常回帰は `test/gui/` の公式通常入力・質問の有限終了・計画承認・独立テスト・別会社レビュー・履歴・単一writer・ローカル操作・スキル管理ダイアログ・配布復旧を確認する。旧経路のcore/session/tool単体テストは通常Vitest回帰に残す。配布資源とモデル復元の失敗した単体テストも除外せず修正する。

`playwright.config.ts` のtestDirは `test/gui` であり、このフォルダーは探索対象外。Vitestは `.test.ts/.test.tsx` のみを探索し、この `.spec.ts` を実行しない。型・lint・整形の対象には残す。

保存ケースを明示的に調べる場合は `scripts/pnpm.ps1 exec playwright test --config=playwright.legacy.config.ts --list` で一覧、`--list` を外して実行する。既存の隔離fake fixtureを使うため実AI通信はしないが、旧ケースの前提を現行起動へ適応させていないため成功は保証しない。通常回帰へ戻す場合は旧経路専用の明示的な模擬プロファイル、または現行仕様に対応するケースを用意する。試験を通すために製品の暗黙fallbackを復活させない。

2026-10-09の棚卸しでは、このフォルダーに実行可能な旧ケース12件が残る。旧14件のうち残る2件は、[improvements](../../Old/retired-sources/manual-improvements-bcca4826/test/archived/gui/improvements.spec.ts.txt)と[model-candidates](../../Old/retired-sources/manual-improvements-bcca4826/test/archived/gui/model-candidates.spec.ts.txt)の非実行txtとしてOldへ保存済み。旧14件すべてが現在のlegacy設定で探索されるわけではない。[非Windows検証のGUI分類](../../docs/report/nonwindows-full-regression-20261009/gui-scope.tsv)を参照する。
