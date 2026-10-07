# 修正経路の検証用 障害注入（2026-10-07、ユーザー承認の案B）

レビュー指摘後の修正サイクルを実通信で確実に確認するため、検証専用の障害注入を追加した。

この段階では、実装とモック・ローカルテストだけを行った。モデル通信・Codexのsandbox診断・ACL/trustedの変更は行っていない。仕様は [SPEC.md §15](../SPEC.md) に記載した。

## 有効になる条件

次の4つがすべてそろうときだけ有効になる（`verificationMode`）。

- `--official-only`
- `--verify-fix-cycle`
- `XHARNESS_FAULT_INJECTION=fix-cycle-v1`
- 既定（`~/.xharness`）以外の、絶対パスの `XHARNESS_HOME`

それ以外では、パネルに作成ボタンが出ない。サービスも `task: "typed-add-v1"` を拒否し、runtimeに注入の設定が渡らない。

## 課題（typed-add-v1）

- ゴール：仕様をそのまま伝える。隠した要件はない。

  > a・bがともに有限のnumberなら和を返す。それ以外（左右どちらでも、NaN・±Infinity・undefined・数値文字列）はTypeErrorを投げる。テストは変更しない。

- 初期状態：`export const add = (a, b) => a - b;`
- 登録テスト：`typed-add`（`node --test acceptance.test.mjs`）
  - 正常例：`add(2,3)=5`、`add(-1,1)=0`、`add(0.5,0.25)=0.75`、`add(1.5,-0.5)=1`
  - TypeError：上記の10通り（左右それぞれ）

## 流れと記録

| 段階 | 対象                                                                                                    | テスト                                    | レビュー         | 何の確認か |
| ---- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------- | ---------- |
| X1   | 実装のコミット                                                                                          | 実施（`injection.stages[quality].check`） | **対象外**       | 実装品質   |
| X2   | 注入コミット（作者 `XHarness fault-injection`、メッセージ `fault-injection: fix-cycle-v1 <effect id>`） | 実施（終了コード1の失敗を想定）           | 実施（base..X2） | 修正経路   |
| X3   | fixのコミット                                                                                           | 実施                                      | 実施（base..X3） | 修正経路   |

- 注入内容は固定で、注入であることをコメントに明記する（`INJECTED_SOURCE`）。
- `record.injection` に記録するもの：
  - `state`・`attempts`・`stages`
  - 各段階の `head`、`checks` / `reviews` の添字
  - 注入時刻・内容digest・許可フォルダ
- baseは最後まで変わらない。
- レポートには「修正経路の検証（障害注入）」の表と、通信上限・予約数を表示する。

## 安全側の扱い

### 注入の条件

注入は、次がすべてそろうときだけ行う。

- 試行が0回で、コミットがX1の1件だけ、HEADがX1。
- workspaceのトップと `--absolute-git-dir` の実体パスが、課題用フォルダの中にある。
- baseの `add.mjs`・`acceptance.test.mjs` が、専用課題の内容と一致する。

これらを満たさない場合は、書き込む前に `fault-injection-outside-boundary` / `fault-injection-not-synthetic-task` / `fault-injection-not-allowed` で止まる。

### 中断と再開

- 書き込む前に、`pendingEffect: inject`・`state: injecting`・`attempts+1` を保存する。
- 次の状態の記録は、再開しない（`uncertain-injection`）。
  - injecting（`pendingEffect` を消しても同じ）
  - failed
  - ineffective
- 注入した後から再開しても、二重には注入しない。
- 注入の設定・通信上限を変えて再開すると、`execution-scope-changed` で止まる。

### 古い結果を流用しない

既存の検知は維持している。

- レビュー前の `stable()`
- 最新のテスト結果のheadと現在のheadの一致（`invalid-checkpoint`）
- `review-snapshot-mismatch`
- 範囲・秘密情報を検査する既存のcommit処理（注入のコミットも通す）

### テスト結果の分類

| 結果                                    | 扱い                                               |
| --------------------------------------- | -------------------------------------------------- |
| 終了コードのある失敗                    | 想定内。修正経路へ進める                           |
| 終了コードなし                          | 停止（`verification-infrastructure`）              |
| 負の終了コード                          | 停止（同上）                                       |
| 監督プロセスの起動・封じ込め失敗（125） | 停止（同上）                                       |
| X2が合格                                | `fault-injection-ineffective` で、レビュー前に停止 |

レビュー指摘0件でも、テストが失敗していれば修正に進む。レビューの見落としとは断定しない（レポートに明記）。

### 通信上限

- phaseごとの上限は、計画1・実装1・修正1・レビュー2。
- runningの記録と同時に、`callBudget.reserved` を送信前に保存する。
- 上限を超える呼出は、送信前に `call-budget-exceeded` で止める。
- 再起動後も、予約数を引き継ぐ。

## 検証（変更範囲のみ）

`fault-injection.test.ts` に14件を追加した。

- 有効化の条件（7通り）。
- 課題：初期・注入・不完全実装が不合格で、仕様どおりなら合格。テストに全ケースがあること。
- X1/X2/X3の分離：コミット・テスト・レビューのhead、fixへの受け渡し、予約数、git log、レポート。
- 指摘0件でもテスト失敗を合格にしないこと。
- X1が不合格なら注入せず、自然な修正経路をたどること。
- 境界外・専用課題以外へは注入しないこと（以降の通信なし、再開不可）。
- 注入の効果がなければ、レビュー前に止まること。
- テスト基盤の異常で止まること。
- 注入中の中断を再開しないこと（`pendingEffect` を消しても同じ）。
- 注入後の再開で、二重に注入しないこと。予約を引き継ぐこと。設定を変えた再開を拒否すること。
- 上限超過の呼出を、送信前に拒否すること。
- 通常の実行には `injection` / `callBudget` が付かないこと。
- 検証モード以外では、サービスが検証課題を拒否すること。

`OfficialWorkflowPanel.test.tsx` に2件を追加した（ボタンは検証モードでだけ出ること、送るコマンド）。

結果：

- official workflow配下とパネルのテストは、19ファイル・259件が成功した。IPC・プロファイルのテストも成功した。
- 型チェック・ESLint・Prettierも成功した。
- 全回帰は実施していない。

## 未確認

- 実通信での修正サイクルの通しは、未実施。
- 配布物へは、まだ反映していない。
- 実通信の手順・通信回数（Codex 3・Claude 2）と停止条件は、[sandbox-node-fixcycle-haiku-20261007.md](sandbox-node-fixcycle-haiku-20261007.md) の4節による。

## Codex引き継ぎ後の限定修正（2026-10-07）

対象は `86df113`（コード `830971a`）からの本コミット、ブランチ `feature/official-workflow-single-task`。上記の実装・試験記録は当時の結果として残す。ユーザー承認済みの修正2点だけを扱い、モデル通信・Codex sandbox診断・ACL/trusted変更・配布物作成は行わない。

### 固定fixtureの失敗判定

`typed-add` だけに `--test-reporter=tap` を指定する。既知の2テストの名前・番号・集計、キャンセル/skip/todoなし、exitとpassedの一致を確認する。不合格はすべて `testCodeFailure` / `ERR_ASSERTION` のときだけ想定内とする。Node起動後のfixture読込エラーや、未知・不完全な結果はexit 1でも `verification-infrastructure` で停止し、レビュー・fixを送信しない。通常のテスト実行や一般のtest frameworkは変更しない。

### 注入内容と承認の結合

注入内容・fixture初期ソース・fixtureテストのSHA256を実行範囲に含める。障害注入の計画承認は計画と実行範囲digestの組合せに対して行い、予算・テスト・注入定義の変更で過去承認を流用しない。保存された定義は再開時、注入境界確認時、pending保存後の書込み直前に現在の定義と照合する。

通常記録は従来の実行/計画承認digestを維持する。以前の障害注入記録は定義情報が足りないため、安全側に再開拒否する。新しい通信予約の保存に失敗した場合はagentを呼ばない。

### オフライン検証

Windows / PowerShell 7.6.5（Codex同梱の `C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。テスト・型チェックは `scripts/pnpm.ps1` とローカルNode 22.23.3（`.tools/node_modules/.bin/node.exe`）を使用。lint/formatは同梱CLIを直接実行し、Node 24.16.0（`C:/Program Files/nodejs/node.exe`）を使用。Store版pwshや配布Electronの確認結果ではない。

- 重点：`fault-injection.test.ts` 20件成功。ログ `.out/codex-fixcycle-focused.log`。
- 関連回帰：`fault-injection`・`runtime`・`catalog-compat`・`service`・`report` の5ファイル90件成功（重点20件を含み、件数は合算しない）。ログ `.out/codex-fixcycle-regression.log`。
- 最終typecheck成功：`.out/codex-fixcycle-typecheck-final.log`。途中の定義共通化でliteral型がstringへ拡大したエラーは戻り値型を指定して解消し、失敗ログ `.out/codex-fixcycle-typecheck.log` も保持した。
- 変更した3つのTypeScriptファイルのESLint成功：`.out/codex-fixcycle-lint.log`。
- 変更したコード・SPEC・本報告書のPrettier check成功：`.out/codex-fixcycle-format-check.log`。`pnpm exec prettier` のshimが見つからなかったため、`node node_modules/prettier/bin/prettier.cjs` を直接実行した。
- 追加した根拠：Nodeによる実際のfixture読込失敗（exit 1）でレビュー/fix未送信、未知exit 1拒否、同一specの注入/fixture digest変更で再開と注入条件確認を拒否、通信予約保存失敗で未送信。
- 既存のX1品質不合格からの自然な修正、X1/X2/X3とテスト/レビューのHEAD対応、注入後再開、予算引継ぎ、通常記録・旧モデル記録も関連範囲で確認する。

全回帰・GUI・build/package・実通信・sandbox診断は未実施。配布物は旧版のままであり、修正サイクルの実測はまだ未確認。
