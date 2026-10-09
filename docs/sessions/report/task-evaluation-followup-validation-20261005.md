> 過去の記録：移動元 `docs/task-evaluation-followup-validation-20261005.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 評価基盤の追加対応・検証（2026-10-05）

対象コード: `feat/task-evaluation` の `a51e42c`（追加開始 `0e1d22f`）。GitHub mainを読み取り再確認し、`4c7d5de4bd46b4d4a7905ee91b9d6208d6fc31cb` のまま。独立作業領域で実装し、原作業領域 `D:/AIwork/Xharness` はHEAD `50e7707c0704e1d5aea5818cdea4bae8a2ef7599`・cleanのまま。push・mergeは行っていない。

## 実装

- 品質結果／In／Out／所要時間をHTMLレポートと比較表の中心にした。cache・reasoning・生usage・呼出根拠は詳細に残す。評価画面に枠消費・API換算額は出さない。
- InはClaudeのinput＋cache-read＋cache-write、Codexのinput。Outは両方outputでreasoningを再加算しない。測定不足は不明、取得済み値と呼出カバー率を併記。旧Claude usageでもcache不足を総Inと誤表示しない。
- 会話・index・receiptは従来形式のまま、`sessions/<id>.evaluation.jsonl`へ開始・終了を追記。実行前にIDを保存し、未完了・失敗・中断は再起動後も継承、完了後は新ID。壊れた末尾の次の追記を別行にし、保存はセッション毎に直列化する。
- LLMの新しい呼出試行にはUUIDのattemptIdを付ける。同じstart/endの再配信と再読込は一度だけ数え、本当に再試行した通信は別に数える。旧traceはspan IDを使用。
- 手動圧縮は未完了IDがあれば帰属して稼働時間へ加える。それ以外はセッション共通のIn／Outと通信時間として別表示。品質結果を変えず、最後の完了タスクへ配賦しない。

## 環境・検証

Windows / Node `v22.23.3` / pnpm `10.34.6`。PowerShell `7.6.5`、実体 `C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`。独立領域にコピーしたローカルNode/pnpmを `.\scripts\pnpm.ps1` で利用。新しい依存・lockfile変更なし。

| 実行                                                                   | 結果                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm test` 全回帰                                                     | 153ファイル・1472テスト成功（175.32秒）                                                                         |
| 最終の共通分欠測フラグ修正後、evaluation / premises-compact / headless | 3ファイル・20テスト成功                                                                                         |
| `pnpm typecheck`                                                       | 成功                                                                                                            |
| `pnpm lint`                                                            | 成功                                                                                                            |
| `pnpm build` 最終ソース                                                | main / preload / renderer成功                                                                                   |
| 隔離 `--fake` GUI: evaluation / smoke                                  | 3件成功（2.5秒）。品質・In・Out・時間、模擬、完全usageカバー率、実fetch送信0、traceリンク、横はみ出しなしを確認 |
| GUIスクリーンショット                                                  | `.out/gui/evaluation-exports-and-dis-e66c8-om-an-isolated-fake-UI-task/evaluation.png` を目視確認               |
| `evaluation:offline .out/evaluation-followup-20261005`                 | 固定3課題×2構成成功。reference3件合格、操作省略3件はoracleで不合格                                              |
| `evaluation:compare`                                                   | `.out/evaluation-followup-comparison-20261005.html` 作成。記録読取のみ                                          |
| Prettier（変更ファイル）・`git diff --check`                           | 成功                                                                                                            |

回帰は、controller/headlessの再起動後ID継承・完了後の新ID、同時send・別セッションの保存、失敗試行、手動圧縮のactive帰属／完了後の共通分、旧会話形式、部分的な履歴末尾、重複start/end、真のretry、usage欠測、レビュー・根拠、trace容量省略を含む。通常の全回帰には既存のworkflow・圧縮・権限・並列処理も含む。

途中の全回帰で新しい手動圧縮検査2件が失敗した。独自Provider mockがtraceStreamを通らずLLM traceを作っていなかったため、実アダプタと同じtrace境界で包むよう修正し、全回帰を再実行して成功。初回lintは作業用の一時CJS編集スクリプトを検出したため、そのスクリプトを削除して再実行成功。実装側のlint抑制は追加していない。

## 未実行・制約

実Claude / Codex / ChatGPT通信、認証CLI、サブスク枠を消費するアプリ内試験、exe／インストーラー、Node24、WindowsApps／Store版PowerShellの検証は未実行。fake結果から実モデルの品質や効率差を断定しない。

再起動時に継承するのは評価IDであり、workflow段階・子プロセスは復元しない。未完了タスクの次の依頼は継続扱い。強制終了で終了spanがなければ時間は不明。traceとactive更新は別ファイルなので、完了直後のクラッシュではactiveが残る場合がある。複数アプリプロセスが同じhomeへ書く用途は対象外。traceのローテーション・読取上限・破損・欠測があれば完全な消費を証明できない。詳細と再実行手順は [評価基盤](../../../Old/doc-layout-0e5fa40/docs/task-evaluation.md)。
