# 品質・使用量の評価基盤

対象: main `4c7d5de` からの `feat/task-evaluation`。現行仕様は [SPEC.md](../SPEC.md) §7・§10。今回の実装は記録・静的レポート・同条件の比較までで、モデル選択や認証には変更を加えない。

## 記録と表示

既存の「HTMLレポート出力」、または `headless --report <sessionId> --output <new-file.html>` の冒頭に「品質・使用量の評価」がある。閲覧・出力・比較はモデルを呼ばない。

- trace の追加 `task` span が親実行を囲み、入れ子の通信・ツール・子・レビュー・自動圧縮・失敗試行に `taskId` を付ける。未完了タスクは再起動後も同じ ID。完了後の次のタスクは別 ID。
- 評価の開始・終了は `sessions/<id>.evaluation.jsonl` に追記する。元の会話JSONL・index・receiptの形式は変えない。実行前に開始を保存し、中断・失敗・未完了workflowはactiveを維持、正常完了で閉じる。旧セッションに記録がなければ新規ID。壊れた行は読み飛ばし、部分的な末尾があっても次の追記は別行になる。
- 各LLM呼出試行にUUIDの`attemptId`を保存する（旧traceではspan ID）。再読込・同じstart/endの再配信を一度だけ数える。新しいstream呼出の再試行は別IDで別消費。ツールの`callId`は既存の意味を保つ。
- 終了理由、各通信の provider/model/effort、模擬か否か、稼働時間、最初の開始から最後の終了までの経過時間、usage の取得率を表示する。子の並行時間を足してタスク所要時間にはしない。稼働時間には承認待ちを含む。再開間の待ちは経過時間だけに含む。
- レビュー試行、指摘により implement へ戻った修正ラウンド、レビュー内容、Bash の入出力、設定された WaveCheck の実行結果を span ID とともに記録する。レビューによらない任意の編集回数は「修正回数」に数えない。
- `completed` はハーネスの正常終了。ReportDone、通常の end_turn やモデルレビューを客観テスト合格とは扱わない。未完了の workflow の end_turn は中断として表示する。テスト合格はオフライン oracle、または利用者が比較 manifest に明示した評価根拠で判断する。一般的な Bash 成功はコマンド実行の根拠であり、テスト実施の証明ではない。

## usage の意味

既存の `inputTokens` / `outputTokens` を保ち、`Usage.measurement` を追加する。生 usage は既知の数値キーのみ保存し、秘密・本文・ヘッダは含めない。Claude の start/delta は更新値として統合し、増分として足さない。iterations があれば各 iteration を一度だけ足し、外側の値は加算しない。

| provider           | In / Out の算出                                     | 内訳                                               |
| ------------------ | --------------------------------------------------- | -------------------------------------------------- |
| OpenAI / Codex     | In = input、Out = output                            | cached は input の内数、reasoning は output の内数 |
| Anthropic / Claude | In = input + cache-read + cache-write、Out = output | cache は別建て。reasoning の独立測定は不明         |

省略・不正な数値は不明。明示された0は測定された0。各項目は「取得済み値の和」と「測定された呼出数 / 観測した呼出数」を示す。total の必要項目が欠けた通信は total 不明。失敗・中断で受信した途中 usage は部分値として残すが、「完全なusage」のカバー率には含めない。SSE 本文・trace 本文の容量省略時も小さい usage 要約を保持する。

receipt と trace の両方に同じ usage があっても、集計は trace だけを使う。totalは正規化したIn＋Out。画面・比較は品質結果／In／Out／所要時間を中心にし、生usage・cache/reasoningの内訳・attempt IDは詳細へ残す。旧記録に新しいタスク境界を推測して追加しない。旧形式のClaude usageでcacheの測定が不足する場合は総In不明（Outは既知分を表示）。金額・API換算費用・サブスク枠は評価画面に表示しない。

## 固定課題を再実行する

Windows では `pnpm` を `.\scripts\pnpm.ps1` と読み替える。Node と pnpm は README のローカル環境を使う。

```powershell
.\scripts\pnpm.ps1 evaluation:offline .out/evaluation-new
.\scripts\pnpm.ps1 evaluation:compare .out/evaluation-new/manifest.json .out/evaluation-comparison-new.html
.\scripts\pnpm.ps1 test src/main/providers/token-usage.test.ts src/main/session/evaluation.test.ts src/main/session/evaluation-offline.test.ts src/main/session/report-trace.test.ts src/main/workflow/wave-checks.test.ts
```

新しい出力先を指定する。既存ファイル・ディレクトリは上書きしない。`comparison.html`、6件の実行 HTML、trace、`assessments.json`、`manifest.json` ができる。

[cases.json](../test/fixtures/evaluation/cases.json) の3課題: fixture の事実読取、文字列の正確な編集、レビュー→修正→再レビュー。FakeProvider とメモリ上の Read/Write/レビューを使い、外部 API・資格情報・実シェル・サブスク枠は使わない。oracle は最後の回答、最終成果物、必須の読取・レビュー回数を検査する。reference は合格、同じ完了文だけ返す shorter-without-tools は不合格となる。これは評価基盤の整合性検証であり、実モデルの能力・速度・効率の証明ではない。

## 保存済みタスクの比較

`evaluation:compare` は次の形式の JSON 配列を読む。home は manifest からの相対パスでもよい。taskId は実行レポートから選ぶ。各条件は利用者が明示する。同一セッションの別タスクを自動的に混ぜない。

```json
[
  {
    "home": "./recorded-home",
    "sessionId": "session-id",
    "taskId": "recorded-task-id",
    "caseId": "edit-exact-v1",
    "taskType": "edit",
    "difficulty": "small",
    "criteriaVersion": "v1",
    "environment": "fixed-workspace-v1",
    "configuration": "model-effort-config-A",
    "assessment": {
      "source": "explicit_evaluation",
      "passed": true,
      "evidence": "固定した受入テストの実行ログと検査対象コミット"
    }
  }
]
```

最初に品質基準の充足を確認し、同じ caseId・種別・難度・基準版・環境の中で使用量と時間を比較する。観測モデル・effort は構成名と別に表示する。欠測・模擬・記録欠落・未評価は参考値にとどめる。全課題を混ぜたランキングや自動 routing は行わない。明示評価はユーザー提供の判断であり、署名付きの検証証明ではない。

## 制約・残課題

手動 `/compact` は未完了タスクのIDが保存されていればそのタスクに帰属し、圧縮処理時間を稼働時間へ加える。完了後や対象なしの場合は「セッション共通分」としてIn／Outと通信時間合計を別表示する。共通分を品質結果や最後の完了タスクへ足さない。タスクIDがあるが境界traceが失われた通信は「境界欠落」として除外する。

アプリ再起動時に継承するのは評価上のタスクIDであり、workflowの実行段階・子のプロセスを復元する機能ではない。保存が確定した未完了タスクは継続として扱うため、無関係な依頼は別セッションにする。未確定の実行は再実行を拒否してレポートに表示する。終了traceを確認できればIDのactive状態を復元するが、欠けたusage・receipt・外部副作用は捏造しない。desktop/headlessは同じhomeの単一writerロックを共有し、別homeのfake環境は独立。同一プロセスのセッション毎の保存直列化とAsyncLocalStorageも維持する。クラッシュで終了spanが欠ければ稼働時間は不明のまま。設計・制約は [保存整合性と単一writer](storage-consistency.md)。

認証更新用CLIの内部通信は観測できず、task usage に換算しない。trace のローテーションで旧ファイルを読めない場合や破損・記録失敗がある場合はカバー率だけで全量を証明できない。既存 trace の読取上限により省略された記録は不完全と表示する。

現段階は HTML 出力を評価の画面として使用する。ライブ評価ダッシュボード、永続的な課題ラベル編集、テスト専用構造化結果、未確定な実行を安全に再開する機能は今後の候補。
