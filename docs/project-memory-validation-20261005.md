# プロジェクトメモリのオフライン検証（2026-10-05）

対象ブランチ `feat/project-memory`、基点 `c32870466ac09f678f65c109949e94cd4fa8a55c`。実装・テストの最終コミットは `86000b2`。この記録を追加する後続コミットは文書のみ。操作と制約は [project-memory.md](project-memory.md)、現行仕様はSPEC.md。

## 作業場所と環境

- 独立clone: `C:\Users\ahwri\Documents\Codex\2026-10-05\task\Xharness`。元の `D:\AIwork\Xharness` は読み取りだけ。終了前に元HEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599` とcleanを確認し、変更を加えていない。
- GitHub mainを読み取り再確認: `4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb`。基点には前段階の保存整合性・履歴検索・安全な再開を含む。push・mergeなし。
- Windows / Node `22.23.3`（`.tools/node_modules/.bin/node.exe`）/ pnpm `10.34.6`（ローカル `.tools`）。pwsh `7.6.5`、実体 `C:\Users\ahwri\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe`。WindowsApps／Store配布版pwshの検証ではない。
- `.agents/skills` の関連SKILL.mdはこのcloneに存在しない。外部skillの取得・インストールは行っていない。

## 実行結果

| 検証                                         | 結果・範囲                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 全体 `test`                                  | 162ファイル・1,544件成功、207.25秒。保存整合性・履歴・quota再開・headlessを含む既存回帰。                                                                                        |
| メモリ＋履歴の関連テスト                     | 3ファイル・27件成功。                                                                                                                                                            |
| 最後の日付範囲・根拠検証変更後のメモリテスト | 2ファイル・15件成功、3.60秒。日付の無限大相当値の拒否を追加後、期待エラー文だけを修正して再実行。全体試験はこの日付境界の追加前で、最後の変更はこの関連試験と最終GUIで確認した。 |
| `typecheck` / `lint` / `format:check`        | 成功。初回lintの未使用テストhelperを除去し、再実行。                                                                                                                             |
| `build:headless`                             | 成功。                                                                                                                                                                           |
| `test:gui`（内包する `build` を含む）        | 8件成功。隔離fake home／fake providerのみ。                                                                                                                                      |
| UI目視                                       | 採用済み本文、種類、状態、確信度、版、作成・更新・期限、出典と根拠種別、編集操作が収まることをPNGで確認。                                                                        |

最初のGUI試験では、tool result後のfake継続が元の通常ユーザー文を拾えず、完了fixtureへ到達しなかった。fakeの該当デモで最新の通常テキストを参照するよう修正し、8件すべて成功した。実providerの経路変更ではない。

新規unit／integrationは、候補が採用前に検索されないこと、採用が追加通信をしないこと、manual候補、project／home／cwd境界、子の明示toolsと親permission callback、plan／readOnly／deny、重複と矛盾表示、明示統合、版競合とユーザー編集保持、期限、無効化・却下・削除、出典rewind／削除、再起動、破損JSON隔離、書き込み失敗注入、同プロセス複数serviceの直列化、秘密マスクとreasoning除外、receiptの存在確認、偽のtool証拠の拒否、検索の件数・本文予算、非信頼tool resultと固定prefixを確認した。

GUIは「fake提案許可 → 候補に出典表示 → ユーザーによる本文編集・採用 → 新規セッション → 検索許可 → 編集した本文と出典の再利用」を確認した。スクリーンショットは再実行時に `.out/gui/project-memory-fake-propos-f0c8e-ore-retrieval-in-a-new-task/accepted-memory.png` に生成される（git管理外）。

## 未実行と残る制約

実Claude／Codex通信、認証CLI、サブスク枠の消費を伴う検証は行っていない。本番モデルによる提案の精度や、悪意ある本文へのモデルの挙動は未検証。OS電源断・敵対的な同時ファイル差し替えの完全保証でもない。exe／インストーラー作成・配布は未実施。

検索はキーワード一致、画面は最新50件、保存はhome全体200件／1 MiB。自動抽出、追加モデル呼び出し、semantic検索、全件ページ送り、グローバルメモリ、headlessの候補採用管理、第三者skillの探索・導入は未対応。今回は同プロジェクトで確認した知識を再利用する最小経路に限定した。
