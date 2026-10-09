# Workflow 仕様

通常の質問・作業フローの振舞いを定義する正本です。目的は [Requirements](Requirements.md)、実装構成は [Architecture](design/Architecture.md)、横断的な安全条件は [製品仕様](../Spec.md) を参照してください。

## 適用範囲と用語

通常の Desktop / headless 会話は共通の `OfficialWorkflowService` を利用します。`verificationOnly` の固定 task・登録テスト・旧検証用 DAG は通常作業の前提ではありません。本書の「限定 DAG」は通常の計画判断から選択される現行の並列フローです。

「申告」はモデル出力、「観測」は harness が得た通信・プロセス・差分の事実です。`completed` だけでは独立テストや全証拠の完全性を保証しません。

## 検証可能な要件

### WF-S01 質問と計画

通常会話は空白だけの入力を拒否し、受領text原文全体を1〜4000文字に制限し、一度分類し、質問なら分類担当の回答を返します。画像入力と実行slash命令は通常経路で拒否します。質問では計画・作業 workspace を作成しません。作業ならユーザーが選択した主モデルで読み取り専用の計画を一度作成します。自動リトライや、並列判断のための二重計画は行いません。

新しい通常計画は `parallelization` を必須とし、`mode: serial | parallel`、理由、`maxParallel: 1 | 2` を持ちます。理由には確認できた資源と調整コストを含め、未測定の速度予測を含めません。条件・未解決事項は任意です。直列は依存のない単一の統合 task、並列は 2〜16 task、最大同時実行数 2 です。循環、不明な依存、独立 task 間のファイル範囲重複、未解決の並列条件は実装開始前に拒否します。

各 task は ID、指示、相対ファイル、受入項目、実装担当の provider/model/effort/理由、別会社のレビュー担当を持ちます。課題種別・難度は任意の LLM 判断であり測定値ではありません。並列では独立 Node テストのファイルを計画に含め、承認済み task のファイル範囲内に限定します。初期の限定並列は Node の独立テストに限り、他言語・他テスト framework はこの経路では未対応です。

### WF-S02 計画と操作の承認

計画承認は計画、作業対象、baseline を含む digest に結び付きます。承認画面は直列・並列と理由、task、担当・effort、レビュー担当、作業場所と結果の適用方法を確認できるようにします。直列は選択フォルダーを直接編集し、並列は所有 workspace の integration に結果を作ります。

承認は workflow、アプリの会話、approval UUID、内容 digest、期限に結び付き、一度だけ消費します。計画承認は service が要求を生成したサーバー時刻から 10 分で期限切れになります。操作承認は queue の先頭を待機中の要求へ昇格させたサーバー時刻から 10 分です。画面を利用者が実際に見た時刻を起点にはしません。同時の操作要求は一件ずつ表示し、取消・再起動・会話不一致・内容変更・重複要求を許可しません。native の thread/turn/item ID はアプリ会話 ID と別です。

計画は明示承認します。通常 native 操作の自動承認設定と「このフロー」の許可は現在の workflow / cwd に限るメモリー上の許可で、禁止操作やファイル境界を上書きしません。並列 integration の独立テストは常に別途 `harness/test` の明示承認が必要です。

### WF-S03 直列の実装・テスト・レビュー

直列は実際の選択 cwd を使い、非 Git や既存変更を拒否する一律の条件を設けません。自動 Git 初期化、worktree 作成、commit、merge、reset、clean は行いません。計画の `files` は作業の手掛かりであり、直列全体の厳密な書込 allowlist ではありません。

計画時のファイル snapshot を承認前後に照合し、変更があれば停止します。snapshot は最大 10,000 ファイル、1 ファイル 8 MiB、合計 128 MiB、深さ 40 に制限し、読取不能や超過を停止します。実装担当は必要なテストを選択・追加・実行し、結果を申告します。直列の記録は `nativeWork.validation = agent-reported` で、harness の独立 `checks` を捏造しません。テストを報告しなかった場合は、その欠測を結果に示します。

レビューは固定した base/head の差分と申告テストを入力にした読み取り専用実行です。レビューが作業ファイルを変更した場合、base/head が不一致の場合、差分外のファイルを指摘した場合は拒否します。`must` / `should` または失敗した申告テストがあれば修正とレビューを最大 2 回繰り返します。解決しない場合は `attention` です。直列は計画 1 回と最大 3 組の実装・レビューで、分類を除き最大 7 呼出しです。

### WF-S04 限定並列 DAG

並列は untracked を含め clean な Git と固定した source root / branch / HEAD を要求します。独立検証の runtime gate が不成立なら、計画後、承認・workspace 作成・実装より前に停止します。直列への無断 fallback、sandbox 外の独立テストへの fallback はありません。

所有した detached worktree に task ごとの依存先 commit を反映し、完了依存を持つ task だけ最大 2 件実行します。task の native 書込は承認済みの具体的なファイルに限ります。scope を保証できない shell command は実行前に拒否します。commit は harness の wrapper で一度だけ行い、モデルが HEAD を変更した場合は拒否します。

一件の失敗では他の実行を取消し、終了を待ちます。完了 task は決定的な順序で所有 integration worktree に取り込みます。競合・取消・不明な mutation は停止し、workspace と manifest を保持します。元の checkout / ブランチに自動適用せず、再送・自動 resume・自動 cleanup をしません。

独立検証は承認済みの `.test.js` / `.test.mjs` を信頼済み Node で実行します。公式 App Server の `command/exec` を使用し、読み取り範囲の制限と network 禁止を実証した runtime のみ許可します。モデル query / thread は使用しません。最終レビューは各実装 provider の反対会社で行います。全 task が Claude なら Codex の最終レビューで足り、混在なら両社を必要とします。

完了には全 node の commit、integration、明示承認された独立検証の成功、必要な最終レビューが必要です。記録は `nativeWork.validation = independent-process`、`dag.phase = complete` と所有 workspace の sourceBase / integrationHead を持ちます。単なるモデルのテスト成功申告ではこの完了条件を満たしません。

### WF-S05 モデル policy と実績

役割 alias は `opus / sonnet / haiku / astra / sol / luna` です。provider と effort は独立に保持します。開始時と呼出し直前に新しい catalog で policy を解決し、一つの通信中は完全 ID / effort / catalog snapshot を固定します。未知・無効・別会社・非対応 effort・quota 不可は停止し、別モデルや別 effort に自動変更しません。過去の計画、完全 ID、digest を新世代に書き換えません。

旧完全IDからpolicyを正規化できるのは、catalogの`historicalIds` / `acceptedIds`へ同じprovider・model familyの対応が明示された場合だけです。似た名前から推測しません。保存policyがあっても元planのID・provider・effortとの対応を照合し、不一致なら停止します。記録の読取と新しい通信の許可は別です。

完了した非 simulated 履歴から実装・修正の実績を抽出します。同一完全 ID / effort / 課題種別 / 難度の指摘重大度、修正ラウンド、token/cache と欠測、承認待ちの重複区間を除く処理時間を計画の参考入力にします。レビューは同一 node・同一差分の反対会社の結果と結合し、欠測を指摘 0 件と扱いません。

モデル観測の不一致、複数モデルの混在、解決証跡の不整合は planner の帰属集計から除外します。thread 累積 usage や provider 不一致は当該呼出しの token 実績と扱いません。旧欠測履歴は参考集計を壊さず、他の有効な履歴を残します。LLM が最終的に担当を選び、点数ランキングや世代間移植を行いません。少数標本、難度、レビュー担当差を内部で考慮し、少ない実績の UI 表示は設けません。

### WF-S06 停止と checkpoint

一通信の通常上限は 120 秒、分類は 60 秒で、承認待ちは除外します。取消・timeout・quota・dispatch 不明・検証失敗を別の記録として残し、出力の一部や未知の exit code を成功へ読み替えません。

native 作業は保存資料を開けても実行 resume は未対応です。再起動時の実行中状態や不明な副作用を再送しません。固定検証用フローに限る safe checkpoint は別の条件を持ち、通常 native の再開可否と混同しません。保存・会話・headless の詳細は sessions 文書の対象です。

## 具体的な API・画面・状態

### 計画と通信契約

専用official-workflow IPCの`chat` parserはtrim後1〜4000文字です。通常会話の原文長検査と同一の入口ではありません。

[contracts.ts](../../src/main/workflow/official/contracts.ts) の strict schema が正本です。task は 1〜16 件、各 `files` は安全な相対パス 1〜30 件、受入項目は 1〜20 件です。並列の Node testFiles は 1〜10 件です。レビューの重大度は `must | should | nit`、テスト申告の状態は `passed | failed | not-run` です。

`AgentRequest` は phase、cwd、model、effort、prompt、outputSchema、timeout、承認 callback を持ちます。phase は `conversation | plan | implement | fix | review` です。限定 task は非空の `writeScope` を渡し、全体レビューには渡しません。`AgentResult` は dispatch、観測モデル、usage の有無、elapsed/timing、出力、停止状態を区別します。

Claude は SDK、Codex は公式 App Server stdio へ接続します。通常 service は旧 Task / worker / ReportDone / SubmitPlan / HTTP 代替経路を登録しません。plan / review / conversation は読み取り専用、implement / fix は native 操作承認を使います。Claude の通常 native 作業では旧 SDK `maxTurns: 8` 制限を課しません。Codex の unified-exec 起動失敗は公開出力の実際の起動失敗を検出し、診断タグだけで失敗と決めません。

Claudeのconversationはnative toolsなし、plan/reviewはRead/Glob/Grep、implement/fixはRead/Glob/Grep/Edit/Write/Bash、nativeWorkではNotebookEditも使います。選択bundleのSkill追加は[スキル仕様](../skills/Spec.md)の4phase条件に限ります。各操作は`canUseTool`とhookによる境界検査を受けます。

Codexの通常native readはcode_mode/hostとshell/unified_execを有効にしますが、read-only sandbox・networkAccess false・approvalPolicy neverです。書込phaseはworkspace-write・networkAccess false・approvalPolicy untrustedで、具体scopeがあるtaskのshellは拒否します。multi_agent/hooks/apps/plugins/remote_plugin/computer_use/browser/skill_search/依存install/tool_suggestを無効化し、MCP空・web_search disabledです。機能flagの存在や有効化からsandbox解除を推定しません。

### 承認コマンド

[shared command](../../src/shared/official-workflow.ts) の `approve` は workflow ID と digest、approval ID / conversation ID を照合します。`tool_decision` は approval ID、digest、許否、任意の `scope: flow` を持ちます。`cancel` は対象会話を照合します。旧 `create` の固定 task / DAG は `verificationOnly` と区別されます。

[native operation](../../src/main/workflow/official/operation-approval.ts) は request UUID、native session/turn/item、command、cwd、targets、reason を持ちます。`harness/test` は workflow UUID、request UUID、test spec digest、cwd、testFiles、絶対 Node path、正確な argv と表示 command、reason を持ち、native ID を捏造しません。argv は `--test --test-reporter=tap` に承認済み相対 testFiles を続けた配列で、shell 文字列として実行しません。

通常 UI は会話内の計画・操作承認と Receipts を使います。専用の旧 Workflow 作業パネルや手動改善比較画面を通常入口にはしません。会話全体と設定画面の詳細は sessions 文書を参照してください。

### 状態と独立証拠

workflow の状態は `planning / approval / implementing / verifying / reviewing / completed / attention / quota-paused / cancelled / interrupted / failed` です。直列の通常経路は計画→承認→実装→レビュー→修正または完了です。限定 DAG は node 作成・実行・commit、integration、独立検証、最終レビューを追加します。

副作用の intent は `pendingEffect`、通信は call、並列作業は node / workspace manifest に保存します。Git mutation 前に intent を保存し、不明な完了を再試行しません。

独立検証の `checks` は process evidence と、raw TAP ではない JSON を保存します。JSON は `mechanism: official-command-exec`、status、tests/pass/fail/cancelled/skipped/todo counts、outputDigest を持ちます。exit 0、正の実行・成功数、失敗・取消・todo が 0、整合する counts を要求し、skip のみや欠測を成功としません。結果引継ぎは別途、計画 digest、所有 workspace、対応する calls/reviews、証拠の完全性を確認します。保存した completion 時の証拠であり、現在の source HEAD を再検証した証拠ではありません。

## 受入条件

| ID     | 条件                                                                              | 直接対応する検証                                                                                                                                                                           |
| ------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WF-A01 | 質問は作業計画へ進まず、作業は一度の構造化計画で直列・並列を判断する              | [service](../../src/main/workflow/official/service.test.ts)、[入力parser](../../src/main/official-workflow-ipc.test.ts)、[native DAG](../../src/main/workflow/official/native-dag.test.ts) |
| WF-A02 | 内容・会話・期限の異なる承認は拒否し、harness/test は flow 許可で通らない         | [approval session](../../src/main/workflow/official/approval-session.test.ts)、[operation approval](../../src/main/workflow/official/operation-approval.test.ts)                           |
| WF-A03 | 直列は snapshot と反対会社レビューを照合し、申告テストを独立成功としない          | [native runtime](../../src/main/workflow/official/native-runtime.test.ts)                                                                                                                  |
| WF-A04 | 並列の依存・範囲・最大 2 件を守り、元 checkout を変更せず競合・不明状態を保持する | [native DAG](../../src/main/workflow/official/native-dag.test.ts)、[project DAG workspace](../../src/main/workflow/official/project-dag-workspace.test.ts)                                 |
| WF-A05 | sandbox 実証なしで本番独立検証を開始せず、raw 実行に fallback しない              | [runtime gate](../../src/main/workflow/official/validation-runtime.test.ts)、[independent validation](../../src/main/workflow/official/independent-validation.test.ts)                     |
| WF-A06 | alias を呼出し直前に解決し、不正 policy と attribution を除外する                 | [model selection](../../src/main/workflow/official/model-selection.test.ts)、[feedback](../../src/main/workflow/official/model-feedback.test.ts)                                           |
| WF-A07 | 完了履歴を通常 planner の参考入力にし、旧欠測履歴でも有効分を保持する             | [feedback service](../../src/main/workflow/official/model-feedback-service.test.ts)                                                                                                        |

これらは対応するテストの所在を示します。この文書整理では再実行していません。mock の契約検証、実 Git の workspace 検証、実モデル通信、対象 Windows の runtime 検証は別の証拠です。本番限定 DAG の対象環境成立と実モデルによる完遂、feedback による品質改善は未実証です。
