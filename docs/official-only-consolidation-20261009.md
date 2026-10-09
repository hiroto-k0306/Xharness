# GUI/headlessの公式経路共通化と旧実行器整理（2026-10-09）

後続の864be74からの作業で、本記録に残したmemory境界/固定課題再開の2失敗はテスト前提を修正して成功した。全回帰1回では別の52失敗が残り、改善評価の公式記録対応不足も確認した。最新状態は [残存2件の修正と全回帰記録](remaining-failures-regression-20261009.md) を参照。以下の当時の集計・検証範囲はそのまま残す。

基準は文書整備完了時の `6370866`、元のmainは `9a275bc`。追加依頼によりheadlessもGUIと同じ公式ワークフローへ接続し、不要となる旧実行器を整理した。今回の環境はクラウドLinuxであり、昨日の実機試験や新Windows配布を再実行した記録ではない。

## 変更

- GUIは `/stop` だけを入力候補へ残し、旧slashと画像を送信前に拒否する。旧phase/MCPの履歴表示を保持し、再操作を理由付きで止める。
- skillsはmainの既存validator・権限確認で選択source/hashを再previewし、本文・出典を4000文字以内の非信頼参考資料として会話へ送る。省略・上限超過・付属資料の送信は拒否する。SDK skills/MCPの有効化や永続登録とは表示しない。
- 判別promptから旧「対象ファイルと既存Node/Vitestテストの事前提案」を外し、選択mainによる公式読取探索と計画へ説明を合わせた。ツール権限やshell sandboxを文書に合わせて変更していない。
- headlessはSessionControllerのofficialSessionからOfficialWorkflowServiceへ接続する。TTYのみ明示的な計画/操作承認を受け付け、非TTYは無断許可せず停止する。TTYのEOF/CtrlC/停止で取消し、保存homeのwriterとサービスを終了時に解放する。旧履歴/レポートは保全し、旧実行へ戻らない。
- 旧HTTP Adapter、旧自前認証更新、旧WorkflowRuntime/ChildRunner、34個の旧model公開ツールを登録経路から撤去した。定義32個を削除し、ListProjectSkills/LoadProjectSkillの2wrapperだけは手動skills UIのvalidation/gate/trace用途で保持する。FileAccess、設定互換型、履歴・memory・skillsの手動UI読取、レポート/再表示、固定接続fixtureは共通利用のため保持した。旧実行器専用testsを撤去し、保存・UI・checkpoint等の共通testsは公式fixtureへ移行した。ユーザーデータ・認証・ACLは変更していない。旧送信slashと予約schedulerを撤去し、旧checkpointの読取・共通復元APIを保護する。公式入口へcwdの存在/directory確認と履歴読込後のworktree・同workspace writer再確認を引き継いだ。

## 履歴保存と文書

元の20資料移動と9a275bcの3仕様書snapshotは [Old索引](../Old/README.md) を参照。追加変更直前のSPEC/DESIGN/FEATURES/README/AGENTS/release READMEの6版も6370866のsnapshotとしてOldへ保存した。元の正規パスには現行版を残す。撤去済みソースの旧資料リンクは当時のGit履歴を参照する。

## 限定検証

| 確認                                                      | 結果                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| f292b0f時の変更testと直接影響testの限定統合（38ファイル） | 356成功、既存memory境界1失敗、Windows依存3skip。全回帰ではない                                    |
| serviceの通常入力判別4ケース                              | 4成功（他47ケースは選択対象外）。旧Node/Vitest事前提案がpromptにないことを確認                    |
| headless                                                  | 上記統合に含む14/14成功。TTY計画/操作承認、非TTY拒否、EOF/CtrlC/stop、旧記録、終了処理。help終了0 |
| 型                                                        | 通常tsc --noEmit、headless tsconfigのtsc --noEmitが成功                                           |
| lint/整形/差分                                            | 変更コード59ファイルESLint成功、変更対象Prettier、SPEC/DESIGNの個別整形、git diff --check成功     |
| 文書リンク                                                | 42文書523相対リンク、破損0                                                                        |
| Old保存内容                                               | 20移動・9保存版。本文は旧版表示/リンク/移動対応を除いて保持                                       |
| リモートmain                                              | 最終fetchでも9a275bcのまま。今回push/mergeなし                                                    |

実行は既存node_modulesのvitest/tsc/eslint/prettierを直接呼び出した。pnpm11の自動インストールを回避し、依存更新は行っていない。限定Vitestは --maxWorkers=1 --testTimeout=30000で実行した。旧実行器撤去に直結するtestだけを整理/移行し、共有保存/取消/排他/履歴等の意味ある確認を残した。

既存 `service.test.ts` の固定課題「persists denied approval across restart」は承認後の完了待ちで失敗した。変更前6370866を別の一時ディレクトリへ展開して同じ限定ケースを実行しても同じ箇所で失敗した。合成記録は独立プロセステストのexitCode:null/passed:falseとなりattentionへ到達していた。今回だけの回帰ではないが、この環境で成功とは扱わない。失敗を隠すテスト削除やtimeout変更は行っていない。

Windows依存、実モデル通信、インストール、ACL/認証変更、全回帰、SDK更新、push/mergeは行っていない。過去の実機成功・PR #25の117成功・Windows3件未確認は [SPEC §16](../SPEC.md#16-最新履歴の検証範囲と残る不一致) の別根拠であり、今回の変更の検証成功へ流用しない。

既存 `session/project-memory.test.ts:161` の異なるcwdでlistを拒否する境界テストも失敗した（拒否ではなく空entriesを返した）。6370866の別ディレクトリで同じ箇所の失敗を確認し、共通projectHistoryAccess本文は基準と一致する。この操作の明示拒否を確認済みとは説明せず、既存の仕様/テスト不一致として残す。全読取/書込で同様になると推測せず、別途確認が必要。

変更ファイル全体は [一覧TSV](official-only-changes-20261009.tsv) に記載（基準9a275bc、A追加/M更新/D撤去/R移動）。文書の20移動＋9保存版の対応はOld索引に集約し、旧ソース・専用testsの撤去はDとして区別する。

## 独立レビュー後の追加確認

レビュー詳細・コード根拠・削除テスト分類は [独立レビュー記録](official-only-review-20261009.md)。別担当は保存/取消/非TTY承認/旧ID履歴/公式のみの境界を確認し、最終修正後に重大な境界欠陥を見つけなかった。これは全機能の無欠陥や実機成功の保証ではない。

今回のheadlessで、閉じた非TTY pipeの質問をEOFで捨てる問題と、非TTY承認不能後のqueued yを次のモデル入力として扱う問題を修正した。非TTY EOFは入力完了として受領済み質問を処理する。TTY終了後は新規dispatchを止め、TTY実行中EOF/CtrlC/stopは取消。非TTY承認不能は当該ターンの取消・保存/idleを待って終了1とし、queued入力を追加送信しない。閉じたpipeは6370866でも成功しなかったため、今回だけの退行と断定しない。

最終headlessは17/17成功（元14の再確認＋新規3）。型・headless型・直接lint/整形/差分確認成功。独立担当の4ファイル50成功と別3ファイル30成功/2skipは重複する実行なので356へ加算しない。356成功/失敗1/Windows3skipはf292b0f時の38ファイル統合の記録で、そこでの失敗はmemoryだけ。固定課題再開は別service単独実行の失敗であり、失敗が計2種類あることと矛盾しない。serviceの判別4ケースだけを成功した別実行と、service全体の成功も混同しない。

[統合ログ](verification-20261009/scoped-suite-f292b0f.log)、[変更前memory失敗](verification-20261009/baseline-6370866-memory.log)、[変更前固定再開失敗](verification-20261009/baseline-6370866-fixed-resume.log)、[固定再開の診断要約](verification-20261009/fixed-resume-observation.json)、[最終headlessログ](verification-20261009/headless-review-final.log)を保存する。これらはオフラインの合成/モック試験で、実機/実モデル試験ではない。

今回レビュー追記後の文書リンク確認は43文書559相対リンク・破損0。上の42文書523リンクはf292b0f時の初回確認として保持する。
