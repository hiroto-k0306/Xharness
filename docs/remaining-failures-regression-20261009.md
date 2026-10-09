# 残存2件の修正と全回帰（2026-10-09）

本記録はe43ddefまでの第一段階。追加18失敗を「2件の修正範囲外」と扱った後、未マージの公式移行差分全体で再調査した。6370866との比較で移行回帰と確認し、改善評価/モデル候補の実装漏れと同等の公式fixtureを修復した。最新状態は [公式移行回帰の修復記録](official-migration-regression-fix-20261009.md)。以下の全回帰52失敗の原集計・ログは当時の結果として維持する。

開始HEADは `864be74b9ad99ca5b4f88c8bc7b886a3ef128f9d`、修正・全回帰対象は `b172e7b`。保存済みクラウドLinux、Node v24.19.0、既存node_modulesを使用した。origin/mainはfetchで `9a275bc99272b34f0c418a59a8fcc63dcabd20fe` と確認した。実モデル通信・依存インストール・資格情報/ACL変更・push/mergeは行っていない。昨日のWindows実機結果を再実行した記録ではない。

依頼されたmemory境界と固定workflow再開を独立担当に委譲し、変更4ファイルを統合後にコミットした。製品コードは変更していない。全回帰中は担当作業を停止し、workerを1つに制限した。全回帰後の追加失敗分類も独立2担当が読み取りで照合した。

## 修正前後と根拠

### memoryの異なるcwd拒否

`/tmp/.git` が存在する環境では、従来fixtureのroot/otherが共通ancestorの同一Git repositoryとして解決される。[project-history.ts](../src/main/tools/project-history.ts)はcommon Git directoryの同一性で同repositoryのworktreeを許可する。cwd文字列の相違だけで拒否する仕様ではない。このため独立プロジェクトのつもりだったfixtureが不正だった。

- [project-memory.test.ts](../src/main/session/project-memory.test.ts)のroot/otherに独立した`.git`を作成。
- 同一common Git directoryのlinked worktreeを許可するケース、独立nested repositoryのlist/proposeを拒否するケースを追加。
- 同じ原因がある[project-skills.test.ts](../src/main/tools/project-skills.test.ts)のhome/rootにも独立identityを付与。
- scope・home検証などの製品実装は変更していない。

修正前はmemory全体10成功/1失敗、修正後12/12成功。memoryと履歴統合・公式handoffの直接4ファイルは34/34成功、skillsは修正前12成功/1失敗から13/13成功。[直接memoryログ](verification-20261009/remaining-failures/memory-direct.log)、[直接skillsログ](verification-20261009/remaining-failures/skills-direct.log)。集計は別実行で、一部テストが重なるため加算しない。

### 固定workflowの再開完了待ち

[owned-process.ts](../src/main/workflow/official/owned-process.ts)はWindows Job containmentを要求し、非Windowsでは `owned-process-platform-unsupported` を投げる。[workspace.ts](../src/main/workflow/official/workspace.ts)のrunAcceptanceはこの拒否をexitCode null/不合格として返す。旧テストはLinuxでも独立checksが成功してcompletedになることを期待し、実際はattentionで終わった後も20秒待ち続けていた。

[service.test.ts](../src/main/workflow/official/service.test.ts)の対象1ケースだけ、非Windowsではテスト用WorkspacePort.testを注入した。承認済みspecが固定のNode/acceptance.test.mjsと一致することを確認し、実際のNode subprocess終了値と出力を使う。Windowsは従来の製品portを使う。これはcheckpoint/承認拒否の永続化と再開制御の検証であり、Windows Jobの成功を模擬した結果ではない。

初回と再開後に同じportを使い、activeId解放後にcompletedを明示assertする。計画1回、全phase列、resumeCount、失敗から成功したchecks、HTML結果のassertを維持した。待機上限20秒と登録timeoutは増やしていない。対象直接テスト1成功（3.35秒、名称フィルターによる対象外50件は未実行）。[再開直接ログ](verification-20261009/remaining-failures/resume-direct.log)。[owned-process.test.ts](../src/main/workflow/official/owned-process.test.ts)には非Windowsの製品拒否を確認するテストを追加した。全回帰後の同拒否テスト直接確認も1成功/既存Windows条件skip 6件だった（[拒否ログ](verification-20261009/remaining-failures/linux-refusal-direct.log)）。

開始HEAD864be74を別一時ディレクトリーへ展開した比較でも対象2件は2失敗、残り60件は名称フィルターで未実行だった（21.67秒）。[修正前ログ](verification-20261009/remaining-failures/before-864be74.log)。旧版6370866の失敗記録も保存したままであり、過去ログを書き換えて成功扱いしていない。

## 全回帰は1回だけ

直接検証・typecheck・変更箇所lint/format・Electron buildが成功した修正HEAD b172e7bで、次を1回実行した。プロジェクト設定と既存成果物除外を維持し、新しいテスト除外・skip・テスト削除は追加していない。既存の明示timeout（DAGの60秒等）は維持した。

```sh
node node_modules/vitest/vitest.mjs run \
  --exclude='spike/.out/**' --exclude='.tools/**' --exclude='dist/**' \
  --maxWorkers=1 --testTimeout=30000
```

| 集計       | 成功 | 失敗 | skip | 合計 |
| ---------- | ---: | ---: | ---: | ---: |
| Test Files |  191 |   13 |    2 |  206 |
| Tests      | 1757 |   52 |   15 | 1824 |

exit 1、開始02:58:29 UTC、所要168.40秒。今回修正したmemory・skills・service・owned-processの4ファイルには失敗なし。[集計](verification-20261009/remaining-failures/full-regression-summary.txt)、[全失敗一覧52件](verification-20261009/remaining-failures/full-regression-failures.tsv)、[完全ログgzip](verification-20261009/remaining-failures/full-regression-b172e7b.log.gz)。完全ログは `gzip -dc` で展開できる。

15skipは既存のWindows/PowerShell条件によるもの：owned-process 6、catalog-compat 2、DAG 1、PowerShell command 3、environment 1、Windows local links 1、SIWC Windows 1。全skipの2ファイルはPowerShell commandとenvironment。今回追加したLinux拒否テストは実行されている。

## 追加失敗の分類と残る課題

全52件について、今回4テストファイルの修正が新たな失敗を生む変更ではないことと、コードの到達経路を確認した。今回の残存2件を越えるテスト移行や機能実装は行っていない。全回帰2回目は実行していない。

| 分類                                         | 件数 | 根拠・残る対応                                                                                                                                                                                                                                                                          |
| -------------------------------------------- | ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 公式固定課題のLinux実行前提                  |   34 | DAG 4/runtime 9/fault-injection 12/planner-choice 1/prepared-runtime 1/project-task 1/project-vitest 6。Windows専用spawnOwnedProcessを呼び、checksのexitCodeがnullになる。後続の注入・import・review等へ未到達でassertが派生失敗。プラットフォーム制約を維持した個別検証設計が必要      |
| 受渡し/CLIの旧fixture                        |    9 | improvements.fixtureが公式入口/接続fixture未指定の旧FakeProvider sendを使い、turn.tsのlegacy_unavailableで停止。最終assistant回答・完了taskが保存されずhandoffが拒否。公式handoff adapterの直接テストは成功したが、この9件の保存/取消/境界カバレッジを公式fixtureで回復したとは言えない |
| 改善/境界/model候補の旧fixtureと公式記録不足 |    6 | 同じ旧fixtureからevaluationTaskが作られず「保存済みタスクがありません」。さらにimprovements.tsのcurrent解決とimprovement-results.tsの旧evaluationTask/evaluateTrace依存は公式workflow結果読取に未対応。fixture移行だけで製品対応が完了すると判断しない                                  |
| スキルUIの旧モデルツール前提                 |    3 | ローカルUI読取後に旧skillLoadPromptを送信し、旧LoadProjectSkill承認とモデル2呼出しを待つ。現在の版確認付き非信頼参考資料送信と不一致。ローカルUI拒否/取消の2ケースは成功                                                                                                                |

Windowsで同じ34件が合格する保証はない。Linux失敗をWindows実機の結果に読み替えない。改善評価の公式記録対応不足は[SPEC §16](../SPEC.md#16-最新履歴の検証範囲と残る不一致)にも記録した。旧モデルツールの復活、製品の非Windows実行許可、テスト削除や失敗を隠すskipによって対応しない。

## 静的検査・ビルドと未確認点

- typecheck、変更4テストのESLint/Prettier、全体ESLint/Prettier、Electron main/preload/renderer build、headless TypeScript buildはexit 0。
- [検査ログ一式](verification-20261009/remaining-failures/)を保存。空ログは成功時無出力のツールによるもの。
- Linuxにpwsh/Xvfbが無く、Windows Job supervisor、Store版pwsh、GUI起動、exe/installerは未確認。実モデル・公式認証・実APIは未試験。
- 今回新しいOld移動はない。既存の[Old対応索引](../Old/README.md)と過去記録を維持した。
- 最終の文書・証拠コミットはこの修正に記録を追加するだけで、全回帰後に製品/テストの動作変更はしていない。ローカルコミットのみ、push/merge無し。
