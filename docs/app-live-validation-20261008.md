# 実アプリの実通信検証（2026-10-08・途中）

ユーザーが実通信と、各検証5回まで、不具合の修正を承認した。検証候補は通常質問/追加質問、Claude実装→Codexレビュー、Codex実装→Claudeレビュー、指摘→修正→再レビュー。予算はXHarnessのphase/query呼出で数える前提を質問し、まず単純な質問を開始した。SDK内部のHTTP回数は観測できないため、5 HTTPリクエスト以内という保証ではない。新しい認可・追加課金・有料API切替・資格情報の抽出/コピーを行わない。

## 対象と環境

checkout：C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness-connections。main e8ee49a12a52fbc7ab4846b1fcc03f5d118a7f18からcodex/app-live-validation-20261008を作成。開始時clean。CIMで当該checkoutに関連する他の作業とXHarnessの既存起動がないことを確認した。D:/AIwork/Xharnessは古い別checkout（50e7707）で変更していない。

ビルドはscripts/pnpm.ps1（Node22.23.3/pnpm10.34.6）、PowerShell7.6.5はCodex同梱版。実アプリはElectron44.5.1。公式Claude Agent SDK0.3.290/同梱CLI2.1.290。Store版pwshでの確認ではない。

新しいwin-unpackedを別出力先へ作り、--official-onlyと絶対XHARNESS_HOME=.out/app-live-20261008-homeで起動した。旧設定・履歴の移行やコピー、上書きインストールはない。公式SDK/App Server自身の既存認証を使い、旧HTTP経路や旧認証更新には接続しない。native DAGは無効のまま。

Windows computer-useで実アプリの表示・入力・通常終了を操作した。初回のhidden起動ではすぐ画面が出ず、同じ隔離profileへの二重起動で既存windowを表示する導線も使った。最終的には通常画面が表示され、既知のFATAL/0x80000003・権限拒否は今回観測していない。この遅延の内部原因は未確定であり、起動の完全な解決と扱わない。

## 配布物とソース

| ソース                                   | 出力（checkout相対）                         | exe SHA256                                                       | app.asar SHA256                                                  |
| ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| e8ee49a                                  | .out/app-live-e8ee49a-dist/win-unpacked      | 66dae84c052240fc30b47a08132f5b6bb81f5bc94e6e2df8db71b62cfe47c6e6 | 0bdccded05adab269b9043bd4c957097b04713bcefd901e50e080cb63a5e69e9 |
| c998a3085cb2d08f60223455d6793ce5e5bf7a9d | .out/app-live-question-fix-dist/win-unpacked | e7c0535d456f9ea64ef237903664ff021404a2f79acbd0e6d2b6a3b8681a0a41 | 65a1bb81217db9f1e0f597ff031601f353c83a233fbba0d82ba14fe00ebdf87f |

両方とも通常build・electron-builder --win --dirは終了0。既存配布物は上書きしていない。author未設定/重複依存/対象外OSの任意SDKバイナリの非同梱は非致命警告。exeや生成profileはGitへ追加しない。

## 検証1：通常質問・追加質問（3/5回）

実アプリの通常promptから送り、自動判別を経由した。3回ともconversation呼出1件でcompleted。計画・実装・レビューは開始しなかった。指定・SDK初期・parent=nullの主系列assistant・resultのモデルはすべてClaude Haiku完全ID（claude-haiku-4-5-20251001）だった。今回の質問でSonnetへのモデル不一致は観測していないが、以前の不一致原因が解決した証明ではない。

| 回  | ソース  | 課題/結果                                                             |   In | Out | cache read | cache create | 時間ms |
| --- | ------- | --------------------------------------------------------------------- | ---: | --: | ---------: | -----------: | -----: |
| 1   | e8ee49a | 2+3。5を含む回答で完了                                                | 1027 | 560 |          0 |         6156 |   7600 |
| 2   | e8ee49a | 同じ会話で漢数字のみを指定。五を含むが余分な説明あり                  | 1141 | 910 |       6256 |         6877 |  11429 |
| 3   | c998a30 | 再起動後、保存済みの同じセッションを開いて再確認。回答は「五」の1文字 | 1272 | 363 |          0 |         6453 |   6019 |

モデル別usageはquery pipeline全体。cache/reasoningをIn/Outへ重複加算しない。SDK内部のHTTP回数とモデル内部の往復数は欠測。画面の回答とworkflow.jsonのanswerは3回目で一致し、保存履歴も保たれた。

### 見つかった問題と修正

判別schemaとプロンプトのsummaryが「入力の説明/要約」と解釈され、「漢数字だけ」の指定を満たさなかった。summaryが画面にそのまま表示される直接の回答であること、質問時は指定された回答形式を守ることをschema descriptionと指示に明記した。SPEC.md §15の「質問は同じqueryで回答し終了」に沿う修正で、通信追加・自動再試行・履歴の書き換えはしない。

ローカルコミットc998a30。既存の自動判別テストを直接回答「五」にし、出力と返却summaryの一致を確認する。service/session関連2 suites・52テスト成功（34.51秒）。型チェック・変更3ファイルのESLint/Prettier・diff --check・通常build・headless build成功。修正後ソースの全回帰は未実施（直前mainの2,083成功を今回の再検証と扱わない）。

## 検証2：Claude実装→Codexレビュー（1/5回・承認待ち）

修正版配布物の「公式workflow」で既存Codex.exeのパスを設定し、Claude実装候補で「合成課題の計画を作成」を操作した。認証情報は入力/コピーしていない。計画queryは指定Opus5.5、parent=nullの主系列assistantもOpus。result modelUsageにはOpusとHaikuがあり、役割をモデル名の集合だけで推測しない。

計画callは12,377ms。Opus In4/Out1023/cacheRead9053/cacheCreate9637、Haiku In2038/Out13/cacheRead0/cacheCreate0。query呼出として1回、SDK内部HTTPは欠測。

workflow ID：f42ac6c1-c829-4d0c-b03d-bdbb2bb495c2。作業場所は隔離profile内の同ID/workspace-owyvGf。変更対象はadd.mjsのみ、a-bをa+bにする。固定acceptance.test.mjs（2+3=5、-1+1=0）の独立node --testを使い、テストファイルは変更禁止。実装Haiku、レビューCodex gpt-6-luna low。画面の計画digestはdb87c6ded2b6b4d0a3571259e5deab8bceca7ae82c8324cc985940d5c0ee6f0b。

製品の計画承認と以前の「利用者確認を実際に通す」指示を維持し、具体的な計画への人間の承認を求めて待機している。ここまで実装・commit・独立テスト・Codex推論レビューは0件。テスト側の無条件承認は使っていない。

## 残作業

計画承認後のClaude実装・独立テスト・Codexレビュー、逆方向、指摘→修正→再テスト/レビューは未実施。各検証5回を超えて続行しない。今回ここまでのモデルquery/phaseは合計4回（質問3、計画1）。公式の接続情報確認はモデル推論callと区別する。

報告時点で隔離検証アプリは計画承認待ちで起動したまま。元のアプリや無関係なプロセスは終了していない。push・merge・ACL変更・新しいログイン/OAuth認可・有料APIへの切替・上書きインストールは行っていない。

診断の保存場所は.out/app-live-20261008-safe-summary.json、-launch.json、-fixed-launch.json、-question-tests.log、-typecheck.log、-lint.log、-format.log、-headless-build.log、build/package各ログ。本文は合成課題のみで、認証情報・思考本文を報告書やfixtureへ保存しない。
