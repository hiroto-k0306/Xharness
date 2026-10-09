# 公式移行回帰の修復（2026-10-09）

対象は未マージの旧workflow撤去・公式統合差分全体。残存2件の修正だけを範囲とする前段階の分類を訂正し、追加18失敗も移行への影響として修復した。コード・fixtureの最終状態は `8163d28`、この後は文書・証拠のみ更新した。クラウドLinux、Node v24.19.0、ローカル依存を使用。2独立担当がfixture移行、別担当が読み取りレビューを行った。

## 比較で確認した回帰

旧実行器撤去前6370866を一時ディレクトリーへ展開し、該当6ファイルを1 workerで比較した。handoff11/CLI1/skill UI5/improvements4/改善境界6/model候補3の **30/30成功**（10.58秒）。[比較ログ](verification-20261009/migration-regression/before-6370866.log)。実モデル通信を使わないfixture実行である。

公式統合後b172e7bで実行した全回帰1回は **1757成功/52失敗/15既存skip**（206ファイル、168.40秒）。[原集計と完全ログ](remaining-failures-regression-20261009.md#全回帰は1回だけ)。18件の実装/fixtureは旧版のまま、旧実行器だけが撤去されていた。旧FakeProviderに最終回答・完了task・旧スキルツールを作らせる前提が現行のlegacy_unavailableで止まり、同等検証の移行と現役機能の接続が欠けていた。既存不具合として放置する分類は不適切だった。

## 実装修正と維持した境界

- [improvement-results.ts](../src/main/session/improvement-results.ts)、[improvements.ts](../src/main/session/improvements.ts)：current taskを公式UUIDとして解決。保存された公式record・receipt・最終回答・固定入力・project適格性を照合し、旧evaluationTask/traceだけに依存する評価を修復。比較/採用時にも再照合し、record/replay/historyのhash変更を無効扱いする。旧記録は受動読取のfallbackを保持し、旧モデル実行を復活させない。
- 同adapter：模擬区分/送信区分の欠測・不正型、usage provider/scope不整合を登録前に拒否。欠測はnull、模擬は参考値。累積thread usageを独立呼出しとして加算せず、複数モデル観測を単一モデルの比較可能な実測にしない。品質は明示評価と厳密な完了証拠を併用し、トークン量だけで優劣を決めない。
- [controller.ts](../src/main/session/controller.ts)：公式モデル候補を空の旧provider登録で絞っていた実装漏れを修復。enabledかつcatalogUnavailableReason無しのモデルを列挙し、fake・disabled・提供終了済みを公式候補へ入れない。候補閲覧はpassiveでSDK通信を追加せず、送信時の認証・枠・能力検証を維持する。

独立レビューでsimulation欠測の格上げ、enabledのまま廃止された候補の誤表示を指摘され、必須provenance検査・退役filter・直接テストで修正した。現役project/nativeのcwd整合もコードで確認し、隔離cwdを無条件に許可する変更は行っていない。最終レビューに重大な指摘は残らない。Windows実機や全機能の無欠陥の保証ではない。

## 同等検証の移行

| 対象                                                                                                                                                                                       | 変更と維持した検証                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [handoff fixture](../src/main/session/handoffs.fixture.ts) / [handoff](../src/main/session/handoffs.test.ts) / [CLI](../src/main/session/handoffs-cli.test.ts)                             | 公式WorkflowRecordと一致するtext-only最終回答を保存。11+1ケースを維持し、再開、重複、取消、失効、同project境界、原子的書込、排他、秘密/reasoning非転送を検証                                                      |
| [スキルUI](../src/main/session/skill-ui.test.ts)                                                                                                                                           | 5ケースを維持。ローカル読取の権限/予算/版/取消、全量の非信頼参考資料送信と保存、ready後の再送なし・暗黙承認なし・停止、付属資料の送信未対応を確認。旧モデル内LoadProjectSkill承認待ちを現行送信へ移行             |
| [改善fixture](../src/main/session/improvements.fixture.ts) / [改善操作](../src/main/session/improvements.test.ts) / [モデル候補](../src/main/session/model-candidates.integration.test.ts) | 固定入力を公式callbackと模擬保存recordへ移行。品質優先、入力/出典/結果改変、未確定、複数固定課題、明示採用/復元、模擬観測、alias/readonly/deny/期限/取消/再起動を維持。新しい退役候補caseを追加                   |
| [公式改善証拠](../src/main/session/improvements-official.test.ts)                                                                                                                          | 13ケース追加。current UUID、再起動後の受動比較、SDK tokensの欠測/模擬、累積usage非加算、登録前simulation/dispatch欠測・usage provider不一致、登録後の回答/入力/session/未完了/pending/usage/receipt改変拒否を確認 |

旧18失敗のケースを削除・skipで隠さず、同等検証へ移行した。旧skillツールのモデル実行を再現することと、現行の参考資料送信の保存・取消・権限境界を維持することは区別する。callbackはoffline fixtureであり、実SDKのnative承認成功の証拠にはしない。

## 最終の直接関連検証

| 実行                                           | 結果                           | 備考                                                                                                      |
| ---------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 移行・追加境界の9ファイル                      | **69/69成功**、skip 0、11.98秒 | handoff11+CLI1+公式handoff19+skill UI5+改善4+改善境界6+モデル候補4+公式改善証拠13+renderer SkillsManager6 |
| モデル候補/controller/公式sessionの3ファイル   | **39/39成功**、skip 0、4.24秒  | 上記候補4件と重複。集計へ加算しない                                                                       |
| typecheck、全体ESLint、変更コードPrettier      | exit 0                         | 独立レビューでも関連検証成功、重複のため加算しない                                                        |
| Electron main/preload/renderer、headless build | exit 0                         | Windows exe/installerやGUI起動とは別                                                                      |

[関連69件ログ](verification-20261009/migration-regression/final-related-69.log)、[controller39件ログ](verification-20261009/migration-regression/model-controller-39.log)、[静的検査・ビルドログ](verification-20261009/migration-regression/)。全回帰2回目は実行していない。69成功を元の全回帰総数へ足したり、最終状態の全回帰合格率を計算したりしない。

前段階で修復したmemory境界と固定workflow再開の2件は [前段階記録](remaining-failures-regression-20261009.md) を参照。今回追加修正はそのテスト/製品境界を緩めない。

## 残る未確認点と変更一覧

全回帰のWindows専用実行器をLinuxで呼ぶ34失敗は、製品が非Windowsを拒否しchecks exitCodeがnullになることを根拠に、**Windows環境での確認が必要**と分類する。Linuxの成功扱い・skip追加・製品実行許可への変更はしない。対象別内訳と52件の原ログは前段階記録に保存した。Windowsで他の原因が無い保証ではない。

pwsh/Store版、Job containment、GUI、exe/installer、実モデル通信・公式認証は未確認。インストール・資格情報/ACL変更・push/mergeは行っていない。新しいOld移動はなし。過去資料と原ログを維持した。

ローカル追加コミット：`f8b2543`（実装3ファイル）、`213ec3b`（fixture/移行テスト7ファイル）、`8163d28`（公式改善証拠13ケース）。README/SPECと前段階記録にも最新結果へのリンク・実装状態を反映した。
