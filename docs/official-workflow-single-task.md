# 公式エージェント単一タスク workflow

ユーザー承認済みの追加範囲。通常アプリの既存経路とstage5接続UIは維持し、開発用の単一タスク実行入口を追加する。入口の対象は一時Gitリポジトリの固定算術課題だけ。

## 実行と証跡

Claude SDKの読み取り専用計画に、実SDK/App Serverのモデル一覧・effort・枠確認結果を渡す。Xがmodelの捏造、未知テスト、対象拡張、循環依存、依存のないファイル競合を拒否する。初期版は1タスクのみ実行。計画HTMLとdigestを確認し、実通信では利用者が承認する。mockだけは固定fixtureを承認する。

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

- 単一タスク専用。DAG実行、独立worktree並列化、通常アプリworkflow UI、配布更新は未実装。
- 永続stateは送信前intentを保存し、保存失敗で以後の実行を止める。再起動後の不確定callを自動再送しない。完全なcheckpoint復元/native resume/再開UIは未実装。SDK resumeは会話だけでGit/DAG/permissionsを復元しないため、各phaseは新規session/thread。
- ClaudeはPreToolUseでfile/commandを事前制限する。Codex 0.160.0に同等のfile別hookはなく、workspace sandbox/承認とXの事後照合で対象外変更のcommitを拒否・保全する。全書込の事前抑止と同一視しない。
- App Server 0.160.0 readOnlyはread rootの限定を表現しない。レビューのshell/native実行を無効化し、提供した全diffを使うよう制限する。厳密な読み取り対象OS隔離は未実装。
- 環境・diff/ファイルサイズ制限、credential path/リンク/秘密値検査はあるが秘密検出の完全性は保証しない。synthetic外への展開前に追加検証が必要。
- testはshellなし・timeout・取消で起動。直系プロセスの取消で、全孫プロセスをWindows Jobへ結び付ける経路は未統合。任意test commandへの展開条件。
- 品質を満たす同種課題/model/effortごとに比較する。異なる難度の単純順位、枠のtoken換算、API価格との混同、auto routing変更は行わない。

環境: Windows、Node 24.16.0、Codex同梱PowerShell 7.6.5、既存Claude Agent SDK 0.3.290、公式Codex 0.160.0。依存追加・認証変更・push/mergeなし。検証対象と結果は文書末尾とローカル.outに記録する。
