# 再実施の終了監視とtimeout調査

2026-10-09、Windows。インストール済みソース40cb47d、調査開始時HEAD114c666、feature/native-workflow-boundary。利用者から再実施・計画承認と、その後の終了監視・エラー確認を直接依頼された。現行仕様SPEC §15。今回の監視・調査では追加のモデル送信、認証操作、再送、許可操作を行っていない。

## 終了した作業

対象workflow: `4adbd58e-9841-4a58-8ee3-5ee049beb64c`。計画digest `935736de1509c4c7dbe8bed821e72bbb185b73e2a9b4e39e8d9c71814f6f6ea3` は実アプリの承認操作で保存済み。目的はCodexの読み取り・コマンド・編集の動作確認と、docs/codex-startup-recurrence-20261009.mdへの結果追記。

| 工程           | 指定モデル       | 経過時間  | 結果                                 |
| -------------- | ---------------- | --------- | ------------------------------------ |
| 自動判別       | claude-haiku-5-5 | 5,261 ms  | completed。主系列assistantも同モデル |
| 計画           | claude-opus-5-5  | 51,202 ms | completed。主系列assistantも同モデル |
| 実装           | gpt-6.1-sol      | 47,601 ms | timeout                              |
| 検証・レビュー | —                | —         | 未実施                               |

保存状態failed / next=complete / error=timeout、終了2026-10-09 08:06:10 JST。画面の工程制限時間による停止表示と照合した。git status / diffは変更なしで、対象文書への追記もない。

CodexのcommandRunsは18件、completed 12件・failed 6件。承認証跡18件はallowed / explicit（自動モードの既存フロー許可経路）。監視者が個別許可をクリックした結果ではない。fileChange証跡0件。通常コマンドの失敗後にも後続コマンドが実行され、native-exec-startup-failedへの誤分類は今回は起きていない。

失敗本文にはnode、git、pwsh、Get-FileHashのCommandNotFoundException / ObjectNotFoundがある。基本的なGet-Content等は成功。ホストでプログラムが存在することだけでは、公式sandboxのPATHやPowerShellのモジュール探索経路の正しさを証明できない。実際の環境値は未観測で、原因を権限不足やCLI破損と断定しない。

## タイマーの独立した不具合

Codex adapterのpauseTimerは呼ばれるたびに `remaining -= Date.now() - resumedAt` を行い、既に停止中か・待っている承認が複数かを管理していない。保存イベントには23:05:35.446〜.449 UTCに8件の並行コマンド要求がある。並行する承認で同じ経過時間を複数回差し引く構造になっている。

実ソースからタイマーのブロックを抽出し、時計・setTimeout・clearTimeoutを偽物へ置き換える通信なしのprobeを実行した。制限120,000 ms、開始から10,000 ms後に8件のpause→resumeを呼ぶと、残り時間は期待110,000 msではなく40,000 msとなり、その値で次のタイマーを設定した。probeは `.out/probe-approval-timer.mjs`、Node24.16.0、終了0。このロジックの重複計上を確認したが、今回の全承認の内部時刻を再現して47,601 msを厳密に計算したわけではない。

修正案は待機中の承認数を管理し、最初の待機開始で一度だけ時計を止め、最後の待機終了で一度だけ再開すること。並行要求・取消・期限切れ・自動許可をオフライン回帰で確認する。120秒を単に延長して不具合を隠さない。環境未検出への対策とは別目的として扱う。

Codex使用量はthread累積の途中測定でIn185,669 / Out1,433、入力内キャッシュ118,400、complete=false。キャッシュを入力へ再加算しない。SDK/App Server内部の全往復回数や最終使用量は欠測。成功やレビュー済みとして扱わない。

今回は原因確認まで。タイマー・環境渡しの製品コード修正、追加の実通信・再インストール、全回帰は未実施。既存アプリと保存証跡は保全して残した。
