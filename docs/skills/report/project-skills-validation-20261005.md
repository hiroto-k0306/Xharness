> 過去の記録：移動元 `docs/project-skills-validation-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# ネイティブスキル基盤の検証（2026-10-05）

対象ブランチ `feat/native-skills`。基点 `0fe1e5199f098b29da329941982f1a6a0d0aada9`、最終コード・テスト `625165b`。後続コミットはSPECとこの検証記録／操作文書のみ。利用法・制約は [project-skills.md](../../../Old/doc-layout-0e5fa40/docs/project-skills.md)。

## 環境と保全

- 独立clone `C:\Users\ahwri\Documents\Codex\2026-10-05\task\Xharness`、専用ブランチ。元 `D:\AIwork\Xharness` は読み取りだけで、HEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599` とcleanを再確認した。元の作業領域・設定・認証ファイルは変更していない。push／mergeなし。
- Windows、Node `22.23.3`（ローカル `.tools/node_modules/.bin/node.exe`）、pnpm `10.34.6`。pwsh `7.6.5` の実体は `C:\Users\ahwri\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe`。WindowsApps／Store版での検証ではない。
- `.agents/skills` の関連SKILL.mdはこのcloneに存在しない。第三者Ponytail等を取得・インストール・実行していない。テストはこの実装専用の隔離temporary project／homeに作るfixtureだけを使った。
- 終了前のGitHub main読み取り確認は `4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb`。今回の基点は承認されたproject-memory HEADであり、remoteへの書き込みは行っていない。

## 実行結果

| 検証                                  | 結果                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 全体 `test`                           | 164ファイル、1,554件成功、207.75秒。既存の保存整合性・履歴・プロジェクトメモリ・枠待ち再開・headlessも回帰対象。 |
| スキルunit＋integration＋評価         | 3ファイル、19件成功、3.53秒。                                                                                    |
| `typecheck` / `lint` / `format:check` | 成功。                                                                                                           |
| desktop `build`                       | 成功（最終 `test:gui` 内で実行）。                                                                               |
| `build:headless`                      | 成功。                                                                                                           |
| fake `test:gui`                       | 9件成功、9.0秒。実通信なしの隔離Electron。                                                                       |
| UI画像                                | スキル本文、選択した相対出典とhash、非信頼注意、予算が既存会話・tool card・receipt欄に収まることを確認。         |

unitは、一覧の本文非開示、source＋hash指定load、frontmatter（name／description・重複キー・alias・巨大header・不正UTF-8）、同名の出典別表示、更新・rename・削除・再起動、既知秘密・資格情報行・秘密鍵blockの除外、未知frontmatterの非適用、traversal・junction・hard link、home／cwd／scratch／workspace忘却、一覧／本文予算、abortを確認した。

integrationは、ListとLoadの独立した既存権限確認、deny／plan／readOnly、子の設定toolsの明示指定と親permission callback、既定子に追加されないこと、固定system／toolsが変わらないこと、4回の既定fake応答以外の補助通信がないこと、本文が品質証拠に混ざらずtrace由来のskillReadsに版と予算が出ることを確認した。skill名`review`を既存slashコマンドとして展開しないことも確認した。

最初のintegrationでは、テストがtraceの先頭ファイルだけを読んでおり、次ターンの分割traceにあるload記録を見落としていた。既存readTraceReplayを使って全partを読むよう修正し、19件および全体回帰を再実行した。子に既存のStopTask／AskUserQuestion／TodoWriteが付くことも考慮して期待値を修正した。初回typecheckの正規表現capture型のエラーは、captureの存在確認に合わせて修正済み。

GUIは、独自SKILL.mdを隔離projectへ配置し、`skills-demo: list`の許可と本文非開示、選択した`source/hash`の`skills-demo: load`許可、本文と非信頼注意、HTMLレポートのスキル参照要約・hash・returnedCharactersを確認した。付属install.ps1は実行されたら失敗する内容を置いたが、一覧／loadはSKILL.mdだけを読み、Bash等を呼んでいない。画像とHTMLは再実行時に `.out/gui/project-skills-explicit-fa-0a4a7-appear-in-evaluation-report/skills.png`・`skills.html`へ生成する（git管理外）。

## 未実行と制約

実Claude／Codex・認証CLI・サブスク枠の通信、第三者スキルの導入、本番A/B、exe／installer配布は未実施。OSの敵対的な同時差し替えを完全に防ぐsandboxの検証や、実モデルが悪意あるスキル本文に従わないことの証明は行っていない。

本機能は2つの固定projectディレクトリとSKILL.mdのみ。管理画面・専用slashコマンド・任意ディレクトリ登録・全件ページ送り・付属asset/script専用処理・自動最適選択・global home探索・外部ダウンロードは未対応。一覧とloadはローカル読取で、以降の別actionの許可は既存permission gateを維持する。
