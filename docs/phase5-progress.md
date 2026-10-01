# Phase 5 進捗

更新: 2026-10-02。ユーザーの「コミットプッシュして次に進む」の指示で着手。

## ブランチと開始点

- Phase 3・4 の差分を目的別の21コミットに分割し、`phase3` の `7bad8d1` まで `origin/phase3` にプッシュした。
- その地点から `codex/phase5` を作成した。main にはマージしていない。
- Phase 3・4 の未実施事項はそれぞれの進捗文書に残している。今回の開始は、それらの確認を済ませたという意味ではない。

## 最初の実装: 計画検証と直列スケジューラ

DESIGN.md §13・§21.2〜21.4 に従い、Electron と通信に依存しない基盤を追加した。

- `PlanItem` と、未信頼の SubmitPlan 引数を受け取る `validatePlan`。
- 項目形式、ID 重複、存在しない依存先、自己・間接循環を拒否する。
- enabled なカタログモデル・設定した aliases・対応 effort を検証する。Ultra は受け付けない。
- Haiku の担当 effort は割当メタデータとして扱う。既存 Adapter と同様に API へ effort を送らない。
- ワークスペースから出る相対パス、絶対パス、Windows の代替ストリーム指定を拒否する。
- Windows の大小文字・区切り文字を正規化し、依存関係のないファイル重複は直列化を要求する。glob の交差が不確かな場合は保守的に重複と判定する。
- 既知の5時間枠使用率が90%を超えた割当は、別プロバイダを提案する警告にする。未知の使用量を消費済みとして扱わない。
- `SerialScheduler` は同時に1項目だけ起動し、依存先の統合まで待つ。main の割当を保持する。統合失敗時は起動を止め、明示的な再試行を受け付ける。
- 入力計画と返すスナップショットを複製し、呼出側の変更による状態破壊を防ぐ。

## 検証

- Vitest: **43ファイル・389件、全件成功、スキップなし**（追加28件）。Windows の PowerShell 依存テストも含む。
- `pnpm typecheck`、`pnpm lint`、`pnpm build`、`pnpm build:headless`: 成功。
- 実 API 送信: Claude **0回**、Codex **0回**。新しい通信や資格情報更新は行っていない。

## 次の作業・未実施

- Task、explorer / reviewer の定義と子セッション、AgentsPanel。
- SubmitPlan の Agent Loop 接続、計画承認、worker の worktree 実行・統合、wave のテスト。
- plan / implement / review の状態機械、レビューの必須指摘・再修正、PhaseBar / ModelPicker。
- Shell フックとプロジェクトフックの初回確認。
- 今回のスケジューラは状態管理のみ。worker の実起動・マージや画面の動作を確認したものではない。並列数の拡張も未実施。
