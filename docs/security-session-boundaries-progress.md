# Git とセッション境界のレビュー対応（2026-10-03）

- 最新 `origin/main`: `dfaea555c82fb7ac707062d06d440d787c54214c`。開始時の作業ツリーは clean（退避すべき未コミット変更なし）。ここから `codex/security-session-boundaries` を作成した。
- 既存処理を追い、今回の4件はいずれも残っていた。前回の修正・L1〜L4は再実装しない。
- package.json、Vitest / electron-vite 設定、Git hooks を確認。pretest / prebuild なし、Git hooks は sample のみ。インストール・アプリ起動・認証・実プロバイダー通信は行わない。

## 1. Git 読み取りの外部実行

- Git の status / diff / log / show は plan / 広い allow / 常に許可でも ask。危険オプションは既存の plan 拒否を維持する。ユーザーが承認したコマンドは任意の設定を実行しうるため、サンドボックス化したという意味ではない。
- 内部 Git は `--no-pager -c core.fsmonitor=false` を付け、内部 status の fsmonitor 実行を防ぐ。内部に diff / show / log の external diff / textconv を用いる経路はない。
- 隔離した一時 Git の無害な fsmonitor スクリプトで再現。内部 status は実行せず、明示した通常 Git status は marker を作ることをテストする。
- 初回検証: 権限関連3ファイル、78テスト成功。内部 Git 対策追加後の検証結果は後述。
