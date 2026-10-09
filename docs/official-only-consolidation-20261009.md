# GUI/headlessの公式経路共通化と旧実行器整理（2026-10-09）

基準は文書整備完了時の `6370866`、元のmainは `9a275bc`。追加依頼によりheadlessもGUIと同じ公式ワークフローへ接続し、不要となる旧実行器を整理した。今回の環境はクラウドLinuxであり、昨日の実機試験や新Windows配布を再実行した記録ではない。

## 変更

- GUIは `/stop` だけを入力候補へ残し、旧slashと画像を送信前に拒否する。旧phase/MCPの履歴表示を保持し、再操作を理由付きで止める。
- skillsはmainの既存validator・権限確認で選択source/hashを再previewし、本文・出典を4000文字以内の非信頼参考資料として会話へ送る。省略・上限超過・付属資料の送信は拒否する。SDK skills/MCPの有効化や永続登録とは表示しない。
- 判別promptから旧「対象ファイルと既存Node/Vitestテストの事前提案」を外し、選択mainによる公式読取探索と計画へ説明を合わせた。ツール権限やshell sandboxを文書に合わせて変更していない。
- headlessはSessionControllerのofficialSessionからOfficialWorkflowServiceへ接続する。TTYのみ明示的な計画/操作承認を受け付け、非TTYは無断許可せず停止する。EOF/CtrlC/停止で取消し、保存homeのwriterとサービスを終了時に解放する。旧履歴/レポートは保全し、旧実行へ戻らない。
- 旧HTTP Adapter、旧自前認証更新、旧WorkflowRuntime/ChildRunner、34個の旧model公開ツールを登録経路から撤去した。定義32個を削除し、ListProjectSkills/LoadProjectSkillの2wrapperだけは手動skills UIのvalidation/gate/trace用途で保持する。FileAccess、設定互換型、履歴・memory・skillsの手動UI読取、レポート/再表示、固定接続fixtureは共通利用のため保持した。旧実行器専用testsを撤去し、保存・UI・checkpoint等の共通testsは公式fixtureへ移行した。ユーザーデータ・認証・ACLは変更していない。旧送信slashと予約schedulerを撤去し、旧checkpointの読取・共通復元APIを保護する。公式入口へcwdの存在/directory確認と履歴読込後のworktree・同workspace writer再確認を引き継いだ。

## 履歴保存と文書

元の20資料移動と9a275bcの3仕様書snapshotは [Old索引](../Old/README.md) を参照。追加変更直前のSPEC/DESIGN/FEATURES/README/AGENTS/release READMEの6版も6370866のsnapshotとしてOldへ保存した。元の正規パスには現行版を残す。撤去済みソースの旧資料リンクは当時のGit履歴を参照する。

## 限定検証

| 確認                                           | 結果                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 変更testと直接影響testの限定統合（38ファイル） | 356成功、既存memory境界1失敗、Windows依存3skip。全回帰ではない                                    |
| serviceの通常入力判別4ケース                   | 4成功（他47ケースは選択対象外）。旧Node/Vitest事前提案がpromptにないことを確認                    |
| headless                                       | 上記統合に含む14/14成功。TTY計画/操作承認、非TTY拒否、EOF/CtrlC/stop、旧記録、終了処理。help終了0 |
| 型                                             | 通常tsc --noEmit、headless tsconfigのtsc --noEmitが成功                                           |
| lint/整形/差分                                 | 変更コード59ファイルESLint成功、変更対象Prettier、SPEC/DESIGNの個別整形、git diff --check成功     |
| 文書リンク                                     | 42文書523相対リンク、破損0                                                                        |
| Old保存内容                                    | 20移動・9保存版。本文は旧版表示/リンク/移動対応を除いて保持                                       |
| リモートmain                                   | 最終fetchでも9a275bcのまま。今回push/mergeなし                                                    |

実行は既存node_modulesのvitest/tsc/eslint/prettierを直接呼び出した。pnpm11の自動インストールを回避し、依存更新は行っていない。限定Vitestは --maxWorkers=1 --testTimeout=30000で実行した。旧実行器撤去に直結するtestだけを整理/移行し、共有保存/取消/排他/履歴等の意味ある確認を残した。

既存 `service.test.ts` の固定課題「persists denied approval across restart」は承認後の完了待ちで失敗した。変更前6370866を別の一時ディレクトリへ展開して同じ限定ケースを実行しても同じ箇所で失敗した。合成記録は独立プロセステストのexitCode:null/passed:falseとなりattentionへ到達していた。今回だけの回帰ではないが、この環境で成功とは扱わない。失敗を隠すテスト削除やtimeout変更は行っていない。

Windows依存、実モデル通信、インストール、ACL/認証変更、全回帰、SDK更新、push/mergeは行っていない。過去の実機成功・PR #25の117成功・Windows3件未確認は [SPEC §16](../SPEC.md#16-最新履歴の検証範囲と残る不一致) の別根拠であり、今回の変更の検証成功へ流用しない。

既存 `session/project-memory.test.ts:161` の異なるcwdでlistを拒否する境界テストも失敗した（拒否ではなく空entriesを返した）。6370866の別ディレクトリで同じ箇所の失敗を確認し、共通projectHistoryAccess本文は基準と一致する。この操作の明示拒否を確認済みとは説明せず、既存の仕様/テスト不一致として残す。全読取/書込で同様になると推測せず、別途確認が必要。

変更ファイル全体は [一覧TSV](official-only-changes-20261009.tsv) に記載（基準9a275bc、A追加/M更新/D撤去/R移動）。文書の20移動＋9保存版の対応はOld索引に集約し、旧ソース・専用testsの撤去はDとして区別する。
