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

## 検証2：Claude実装→Codexレビュー（3/5回・成功）

修正版配布物の「公式workflow」で既存Codex.exeのパスを設定し、Claude実装候補で「合成課題の計画を作成」を操作した。認証情報は入力/コピーしていない。計画queryは指定Opus5.5、parent=nullの主系列assistantもOpus。result modelUsageにはOpusとHaikuがあり、役割をモデル名の集合だけで推測しない。

計画callは12,377ms。Opus In4/Out1023/cacheRead9053/cacheCreate9637、Haiku In2038/Out13/cacheRead0/cacheCreate0。query呼出として1回、SDK内部HTTPは欠測。

workflow ID：f42ac6c1-c829-4d0c-b03d-bdbb2bb495c2。作業場所は隔離profile内の同ID/workspace-owyvGf。変更対象はadd.mjsのみ、a-bをa+bにする。固定acceptance.test.mjs（2+3=5、-1+1=0）の独立node --testを使い、テストファイルは変更禁止。実装Haiku、レビューCodex gpt-6-luna low。画面の計画digestはdb87c6ded2b6b4d0a3571259e5deab8bceca7ae82c8324cc985940d5c0ee6f0b。

利用者が実アプリで計画を承認し、「承認しました」と報告した。引き継ぎ時点で既にimplementing/2 callsだったため、エージェント側で承認を二重に操作しなかった。テスト側の無条件承認は使っていない。

Haiku実装26,380ms、In1381/Out2268/cacheRead74216/cacheCreate13826。指定/SDK初期/parent=nullの主系列assistant/resultモデルはHaiku。Editでadd.mjsを変更し、Xが211e6480627be157d38d10e469520ec22bd93ceeへcommitした。base f1f0a407478e5555bd21bba7f10f3718553056ccとの実差分はa-b→a+bだけで、acceptance.test.mjsは不変。

Xが独立実行したarithmeticテストは終了0、passed=true、1,539ms、source=process。テスト1件の中で加算2例をassertしている。Haiku側のBashテスト要求2件は拒否され、その結果を独立テスト合格に読み替えていない。

Codex gpt-6-luna lowの固定base/head全差分レビューは4,684ms、In10173/Out63/cache0/reasoning0、usage complete=true（thread-cumulative、モデル別配賦は提供なし）。read-only/approval never。指摘0件でcompleted、修正0回、計画/実装/レビューのphase計3回。画面のcompleted・実テスト合格・指摘なしと保存JSONの一致を確認した。指摘→修正サイクルはこの試験では検証していない。

## 検証3：Codex実装→Claudeレビュー（3/5回・成功）

実アプリの実装候補をCodexへ変更し、別の固定合成課題の計画を1回生成した。計画はOpus5.5 high、11,860ms。モデル別usageはOpus In4/Out1099/cacheRead14088/cacheCreate4559、Haiku In2039/Out16/cache0。主系列assistantはOpusで、モデル集合だけからHaikuの役割は断定しない。

workflow d85f6856-564d-4b2d-8131-724ace1340ea、隔離workspace-cOMlN8のadd.mjsのみを同じa-b→a+bへ変更する。実装Codex gpt-6-luna low、レビューClaude Sonnet5.5 low、独立テストnode --test acceptance.test.mjs。表示digest 877d685cf7ac1d920e3ac8c3a3f23ab514f3c862be9faa5eb1c9df7f3cd8efb6への人間の承認を受け取り、実アプリの計画承認を操作した。最初は画面外のボタンへの入力が拒否されたため、新しい観察からパネルをスクロールして操作した。実装が1回開始し、承認の二重実行はしていない。

CodexがWindows PowerShell -Command経由のGet-Content -Raw add.mjsを要求し、XHarnessの限定承認画面が出た。対象は同workspaceのadd.mjsだけ、request 71828d02-03ff-4576-88c2-4b5836d07066、期限7:57:47。利用者から「操作して許可してください」と、この操作への直接の許可を受けた。request・コマンド・対象・期限を画面で照合して「今回の操作だけ許可」を1回操作した。画面外のUIA座標は入力前に拒否されたため、最新スクリーンショットの可視ボタンを使った。許可を他の操作へ使い回していない。fileChangeは既存の計画scope検証で許可された。

Codex実装は終了completed、In45750/Out235/cacheRead33024/reasoning0、thread-cumulative・complete=true（モデル別配賦はなし）。elapsed305088msは人間の承認待ちを含み、待機中のphaseタイマー停止によって120秒を超える表示となる。変更commitは672878db3a104e7b6b649fc418e76a8cb45daf6a、base663a1577660741fce9ce3d37d0217a716d1268a4。実差分はadd.mjsのa-b→a+bだけで、テストファイルは不変。

独立arithmeticテストはsource=process、1718ms、exit0/pass。Claude Sonnet5.5レビューは11858ms、Sonnet In2/Out234/cacheCreate8052、Haiku In1817/Out10/cache0。指定/SDK初期/parent=nullの主系列assistantはSonnet。固定base/headレビューは指摘0件、completed・修正0回。画面と保存JSONの終了・テスト・レビューの一致を確認した。

## 検証4：指摘→修正→再テスト→再レビュー（1/5回・計画承認待ち）

同じc998a30配布物を通常終了後、別の空の絶対home `.out/app-live-20261008-fix-cycle-home` と `--official-only --verify-fix-cycle`、`XHARNESS_FAULT_INJECTION=fix-cycle-v1` で起動した。元のprofileは保護した。専用typed-add-v1課題だけに注入する既存機能で、品質テスト合格後にX2の明示的な不良コミットを書き、独立テスト失敗・全差分レビュー・X3修正・再テスト・再レビューを確認する。plan1/implement1/fix1/review2の5回上限は送信前に保存・確認される。

workflow 0a10154e-50fb-4d3c-94ea-55f1683a7945、workspace-6k6h5c。計画はOpus5.5 high。対象add.mjsだけ、有限数の加算、それ以外（NaN・±Infinity・undefined・数値文字列を両側）でTypeError。固定typed-addテストは変更不可。計画が選んだ実装/修正はClaude Sonnet5.5 low、レビューCodex gpt-6.1-sol low。画面の計画digest2ca23430701f958097d521d7e094f4a1417d673c11c656dd795db58bf77d512eを利用者へ提示し、具体的な計画と承認ボタン操作の確認待ち。最初の依頼では内部executionDigest08d094…を誤記したため、画面を再照合して訂正した。課題・担当モデルは同じで、未承認のまま実装を開始していない。まだ実装/注入/修正は実行していない。

## 残作業

専用障害注入課題の承認後の実装・テスト・指摘→修正→再テスト/レビューは未実施。各検証5回を超えて続行しない。ここまでのモデルquery/phaseは合計10回（質問3、正方向3、逆方向3、修正サイクルの計画1）。公式の接続情報確認はモデル推論callと区別する。

隔離検証アプリは検証4の計画承認待ちで起動したまま。元のアプリや無関係なプロセスは終了していない。push・merge・ACL変更・新しいログイン/OAuth認可・有料APIへの切替・上書きインストールは行っていない。

診断の保存場所は.out/app-live-20261008-safe-summary.json、-launch.json、-fixed-launch.json、-cycle-launch.json、-question-tests.log、-typecheck.log、-lint.log、-format.log、-headless-build.log、build/package各ログ。本文は合成課題のみで、認証情報・思考本文を報告書やfixtureへ保存しない。
