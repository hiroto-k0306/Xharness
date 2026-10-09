> 過去の記録：移動元 `docs/skill-suggestions-validation-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# スキル候補提示の検証 — 2026-10-05

## 対象・環境

- 実装／テストrevision: `8bba2037ed0cc7e90aa179f06194b7fd2c9db150`。この記録と仕様・操作説明は後続docsコミット。
- 開始点`6f6d9ce0b4588cb0f03b12c1f22073244f925cde`、新branch `feat/skill-suggestions`。独立clone `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness`。push・mergeなし。
- 元の`D:/AIwork/Xharness`は編集せず、最終読取時のporcelainは空。前段のHEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`を維持。
- Windows／ローカルNode `22.23.3`（`.tools/node_modules/.bin/node.exe`）／pnpm `10.34.6`（同`pnpm.cmd`）／PowerShell `7.6.5`（`C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。WindowsApps／Store版pwshとNode24での新たな確認は未実施。
- fake UIは隔離homeとtemporary project、その他はFakeProvider・mock・独自fixture。実Claude／Codex通信、認証CLI、サブスク枠、第三者スキル取得、付属script実行は行わない。

## 実行結果

| 検査                 | 結果                                |
| -------------------- | ----------------------------------- |
| 関連単体／許可テスト | 2ファイル・7件成功                  |
| 全Vitest             | 166ファイル・1,561件成功、241.15秒  |
| 最終fake UI          | 12件成功、13.7秒。desktop build成功 |
| typecheck／lint      | 成功                                |
| format:check         | 成功                                |
| build:headless       | 成功                                |
| git diff --check     | 成功                                |

全Vitestの実行中に追加した最後の変更は、rendererのプレビュー失敗後の候補非表示、実行中の説明文、GUIの候補復帰、予期しないIPCエラー時の旧プレビュー解除。これらは最終typecheck／lint／fake UI／desktop buildで再確認した。単体の選定処理とmain側は全Vitest開始後に変更していない。

## 確認した内容

- 日本語依頼、英語の単語一致、全角英字の正規化、名前優先、一致語の理由、同点source順、繰返し語の重複加点なし。
- 単語断片（use／user）、一般語だけ、空入力、0件、sourceの語だけ、本文の語や命令だけでは候補を作らない。
- 多数件は入力一覧の最大50件を比較し3候補まで。500文字、16語、理由3件等の上限を設け、候補の省略件数を表示する。精度ベンチマークや最適性の検証とは扱わない。
- fake UIで送信前の会話入力を候補用にコピー。未取得・許可拒否・取消時は候補0件。許可後の6件一致から3件と省略3件を提示。英語・日本語の入力変更、0件、候補連打でも自動読取・モデル実行なし。
- 候補の明示選択→既存許可を伴うプレビュー→通常sendによる明示load→実receiptの読込済み表示まで検証。本文だけにあるcache語は候補選定に影響しない。
- 入力変更で旧選択／プレビュー解除。ファイル変更後の旧hashによるプレビュー失敗、候補非表示、再取得取消後も非表示、再取得後の新版プレビューを確認。既存の管理画面回帰で削除・不正定義・狭幅・Esc／focus・入力中の許可ショートカットも成功。
- 最終`suggestions.png`を目視し、最大3候補、関連度・一致語の理由、出典/hashが表示され、管理dialog内でスクロールできることを確認。出力は`.out/gui/skills-manager-task-sugges-af7b0-s-without-automatic-loading/suggestions.png`（Git対象外）。

## 未実施・制約

候補は語一致による参考提示で、品質や最適性を保証しない。同義語・活用形・否定・多義語・難度は推論せず、短い略語や語分割の差で取りこぼす。既に取得した一覧のsnapshotはファイル変更を自動検知しないが、実読取時に既存hash／境界を再確認する。実モデルでのtool選択・安全性、本番A/B、認証・サブスク残量、配布exeは未検証。自動実行・自動ルーティング・第三者導入・global探索・付属script実行は追加していない。
