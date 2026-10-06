# 公式エージェント単一タスク workflow

2026-10-06の後続でWindows Jobによる子孫回収と固定fixtureの模擬DAGを追加した。この文書の初版で未実装としたJob/並列の境界は、[後続の仕様・検証記録](official-workflow-dag.md)を参照する。実providerの並行書込み隔離・一般project適用・native会話resumeは引き続き未対応。

ユーザー承認済みの追加範囲。通常アプリの既存経路とstage5接続UIは維持し、通常画面の「公式workflow」パネルと開発CLIを追加する。対象は独立した管理用Gitリポジトリの固定算術課題だけ。元のユーザープロジェクトは変更しない。

## 実行と証跡

Claude SDKの読み取り専用計画に、実SDK/App Serverのモデル一覧・effort・枠確認結果を渡す。Xがmodelの捏造、未知テスト、対象拡張、循環依存、依存のないファイル競合を拒否する。初期版は1タスクのみ実行。通常UIは模擬時も計画・対象・テスト・担当model/effort・理由・digestを確認して利用者が承認する。開発CLIのmockだけは固定fixtureを承認する。

Claude実装はSDKのnative tools・テスト・自己修正ループ、Codex実装は公式App Serverのnative loop。隠れた子エージェント、MCP、ネットワーク、認証変更、package install、modelによるgit commitは許可しない。Xが対象を照合してローカルcommitし、独立プロセスで指定受入・全体テストを実行する。その後、実装と別providerが固定base/headの全diffをレビューする。

レビューはfile/line/severityと具体的根拠が必須。テスト失敗またはmust/shouldで同じ担当へ戻す。最大2修正、最大7外側query。nitだけでテスト合格なら完了。SDK内部ターンは各query最大8。

JSONに計画、承認、状態、callごとの指定・観測model/effort、native session/turn、tool input/output digest、commit、実テストexit code/出力、レビュー根拠、時間、枠snapshotを保存。HTMLで確認できる。認証情報・思考本文・native生ログは保存しない。

既存traceのtask/LLM/WaveCheck/RequestReviewと同じtask IDを使い、既存評価へusage・configured check・model reviewを渡す。モデルの成功申告を実テスト合格として扱わない。mockはsimulatedとして実モデル比較から分離する。

## usageと枠

ClaudeのmodelUsageはquery全体の累積値を一度採用し、main loop usageやassistantイベントを足さない。欠けた場合はmain loop/partial main loopとして不完全に扱う。Anthropicのcache read/writeはinputに追加。Codexは新規ephemeral threadの最終tokenUsage.totalを一度採用し、通知を合算しない。input内cache、output内reasoningは内数。native数値を保持し、未取得はnull・カバー率へ反映。runningのintentは未確定として別に数える。

枠をトークンやAPI費用から推測しない。ClaudeはSDK accountInfo/UsageでfirstParty、subscription、API key経路なし、Extra Usage無効を各query直前に確認。Codexは公式App Server自身のChatGPT認証とordinaryUsageAllowed/creditsを確認し、SIWC登録は不要。枠不明・拒否・課金fallbackの可能性があれば停止する。Xはcredentialファイルを読まない。新規ログイン・登録・認可をしない。

## オフライン再実行

```powershell
npx tsx scripts/official-workflow.ts --fake
npx tsx scripts/official-workflow.ts --fake --implement-provider codex
npx vitest run src/main/workflow/official
```

両方向で意図的初回不正実装、実Nodeテスト失敗、別providerレビュー、修正、再テスト・再レビューを再現する。consoleにworkspaceと証跡homeを表示する。report.htmlで計画・結果、workflow.jsonで詳細、同じhomeのtraceで既存評価形式を確認できる。証跡を自動削除しない。fixtureモデルを能力・速度・品質ランキングには使わない。

## 明示許可された最小live確認

```powershell
npx tsx scripts/official-workflow.ts --authorized-live --synthetic-only --codex '<公式codex.exe絶対パス>' --codex-model '<実catalogの承認済みmodel>'
```

別途ユーザーの通信許可が必要で、CLIフラグは許可を代替しない。実catalogから利用可能なOpusを計画、Haikuを小さい実装候補にする。逆方向は--implement-provider codex。Opus名を固定CLI aliasとして捏造しない。モデルとincluded usageが確認できなければqueryを送らず停止。計画HTMLを確認して、そのdigestの計画にapproveを入力する。任意プロジェクトの実通信や自動再試行はこの入口にない。

## 残る境界

- 単一タスク専用。DAG実行、独立worktree並列化、一般プロジェクト適用、配布更新は未実装。
- 通常UIで中断と安全な段階からの再開を実装。home/official-workflows/<task ID>にstate・HTML・trace・独立Git作業を保持する。承認待ちの中断後は同じ計画で再承認し、完了済み計画queryを再送しない。固定HEADとgoal/files/test commandsのexecution digestを照合し、許可を拡張しない。
- 永続stateはquery送信前、commit前、test前のintentを保存する。プロセス中断の状態をinterruptedとして復元し、running call/未確定commit・test/phase結果を保存し終えていない状態は再送・再開を拒否する。保存済みverify/review/fix境界だけを継続し、完了済み実装を再実行しない。旧stateのexecution digestが欠ける場合も自動移行・再開しない。完全なnative会話resumeは未実装。SDK resumeはGit/DAG/permissionsを復元しないため各phaseは新規session/thread。
- ClaudeはPreToolUseでfile/commandを事前制限する。Codex 0.160.0に同等のfile別hookはなく、workspace sandbox/承認とXの事後照合で対象外変更のcommitを拒否・保全する。全書込の事前抑止と同一視しない。
- App Server 0.160.0 readOnlyはread rootの限定を表現しない。レビューのshell/native実行を無効化し、提供した全diffを使うよう制限する。厳密な読み取り対象OS隔離は未実装。
- 環境・diff/ファイルサイズ制限、credential path/リンク/秘密値検査はあるが秘密検出の完全性は保証しない。synthetic外への展開前に追加検証が必要。
- testはshellなし・timeout・取消で起動。直系プロセスの取消で、全孫プロセスをWindows Jobへ結び付ける経路は未統合。任意test commandへの展開条件。
- 品質を満たす同種課題/model/effortごとに比較する。異なる難度の単純順位、枠のtoken換算、API価格との混同、auto routing変更は行わない。

環境: Windows、Node 24.16.0、Codex同梱PowerShell 7.6.5、既存Claude Agent SDK 0.3.290、公式Codex 0.160.0。依存追加・認証変更・push/mergeなし。検証対象と結果は文書末尾とローカル.outに記録する。

## 2026-10-06 検証結果

ブランチは`feature/official-workflow-single-task`。公式adapter・状態機械の検証対象は`95f8e91047be5b0d473cd93b2b9804a9b5a6d78c`。全回帰197ファイル/1780テスト合格（226.93秒）、typecheck/lint/format、Electron/headless build合格。既存fake GUIは22合格・2スキップ（50.1秒）。スキップはportable exeとpackaged restartで、今回配布exeを作成・更新していないため。

最後にmock CodexのfixtureをOpenAI内数/thread累積usageへ合わせた`0066c0f6acdf225d1e4367025ab9543617aac39e`で、関連4ファイル/34テスト（12.8秒）、typecheck/lint/format、両buildを再確認し全合格。全回帰の重複実行はしていない。描画検証の一時CJSが後続lintに含まれて1件失敗したため、生成した一時helperだけを片付け、最終lintが合格した。

両方向のmock E2Eは初回テストexit 1→修正1回→最終exit 0、固定base/headの別providerレビュー2回、ローカルcommit2個でcompleted。各5模擬callsの既知合計In70/Out10。cache writeは3/5 callsで取得し、残りを0としない。実テストはNodeプロセス、モデルはmockである。実モデルの品質比較には使わない。

`report.html`を隔離Electronで開き、模擬表示・実テスト欄・全diffレビュー欄とcall行を確認、スクリーンショットを保存した。最終mock証跡は`.out/official-workflow-evidence/claude-implementation.{html,json}`と`codex-implementation.{html,json}`、`report-ui.png`。trace元homeはそれぞれ`C:\Users\ahwri\AppData\Local\Temp\xh-official-evidence-1mQyOt`と`xh-official-evidence-lgY8R3`。作業Gitも別の一時リポジトリで保全している。

検証JSONは`.out/official-workflow-final-validation.json`（全体）、`official-workflow-final-fixture-validation.json`（最終fixture）、`official-workflow-vitest.json`（全テスト）、`official-workflow-focused.json`（関連テスト）、`official-workflow-report-ui.json`（HTML表示）。元の`D:\AIwork\Xharness`はHEAD`50e7707c0704e1d5aea5818cdea4bae8a2ef7599`・cleanのまま。

今回の新workflowの実通信は0件。最小synthetic live確認は自動承認審査が、委任元のfake/mock限定・サブスク使用禁止を理由に起動前に拒否した。回避・再試行せず、認証変更・新規登録・課金fallbackもしていない。実SDK/App Serverによる計画→実装→レビューの成功は未確認であり、別途明示許可を要する。

## 通常UI統合と安全な再開

通常画面の「公式workflow」を開き、実装候補を選び「合成課題の計画を作成」する。fakeではモデル通信なし、受入テストは本物のNodeプロセス。Electron自身をNodeとして再起動しないよう、Electron環境ではPATH上のNodeを使う。実経路は既存設定auth.codexCliPathを必要とし、計画開始前に枠消費を表示する。SDK/App Serverはユーザー操作後にだけ起動し、起動時に認証・モデル確認を自動実行しない。

計画の承認・中断、保存状態の閲覧・再開、実テスト結果と全差分レビュー、native/usage記録、既存ローカルリンク確認を通したHTML表示を通常UIで扱う。IPCは所有window/main frameとstrict commandを検証し、rendererからcwd・shell command・権限変更を渡す入口は作らない。アプリ終了時は両engineを中断し、保存完了を待つ。

接続事前確認中の失敗・中断も保存する。モデルcallがなければcallsは空でusageを捏造しない。再開時は実workspaceのclean/HEADと実行条件digestを確認し、人間の変更を取り消さない。scope・構成が変わる、結果が不明、未取得の枠は安全停止する。再起動後に以前のツール許可や会話resume権限を復活させない。

単一タスクのUI E2Eでは中断→画面リロード→再承認→合格と両provider方向を確認。main serviceの新規instanceでは承認待ち復元、送信済み不確定callの拒否、変更workspaceの保全、事前確認失敗の記録を検証する。runtimeでverify/review checkpointから完了済みmodel作業を再送せず継続することと、test command変更時の拒否を確認する。

親から後続ユーザー許可の引用と「同じコマンドを1回だけ再試行」の明示指示を受け、2026-10-06にその1回を再試行した。自動承認審査は引用を「untrusted assistant-provided evidence」と扱い、元のfake/mock限定を理由に再び起動前に拒否した。指示どおり停止し、経路変更や追加再試行はしていない。今回workflowの実プロバイダquery・サブスク使用は引き続き0。既存stage5の過去の実通信とは分ける。

## 通常UI・中断再開の最終検証（2026-10-06）

最終コードの検証対象は `e3090b2a45350a037011047df41ebb61f2942944`。全回帰は199ファイル・1787テストすべて合格（249.30秒）。typecheck、lint、format、Electron build、headless buildも合格した。以後の変更はこの検証記録のみ。

GUI全体の最初の実行では22件合格・2件スキップ・既存改善比較1件タイムアウトだった。比較用selectが有効になる待機で止まり、新workflowのE2Eは合格していた。既存テストをコード変更なしで単独再実行すると1件合格（2.3秒）、続くGUI全体の再実行は23件合格・2件スキップ（56.0秒）。最初の失敗を取り消さず、タイミング依存の未解消事項として残す。スキップはportable exeとpackaged restartで、配布exeを作成・更新していないため未実行。

途中で見つかったpreload公開APIの旧allowlistは、専用workflow操作を含む契約へ更新し、既存local file境界の検査を維持した。ElectronをNodeテストとして起動してしまう問題はPATHのNodeを使うことで修正し、その後の新workflow GUIは合格した。runtime/service/IPCの関連6ファイル・41テストも合格。新規service instanceによるプロセス喪失状態の復元・不明なdispatchの再送拒否と、保存verify/review段階からの再開はmockで検証した。配布版の実プロセス再起動は上記のとおり未実行。

証拠: `.out/official-workflow-ui-final-validation.json`、`.out/official-workflow-ui-final-vitest.json`、`.out/official-workflow-ui-final-gui.log`（最初のGUI結果）、`.out/official-workflow-ui-final-gui-rerun.log`（再実行）、`.out/official-workflow-ui-final-gui-rerun.json`、`.out/official-workflow-ui.png`（通常UI）。スクリーンショットでは実Nodeテストの失敗・合格、別providerによる全差分レビューと修正1回を確認した。

この新workflowの実通信再試行は1回のみで、審査が起動前に拒否したためprovider query・サブスク消費は0。DAG並列、一般プロジェクトへの適用、native会話そのもののresume、Windows Jobによる全孫プロセス管理は次段階のまま。ユーザーの元作業領域 `D:\AIwork\Xharness` はHEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`・cleanを確認し、push/merge・アプリ更新は行っていない。
