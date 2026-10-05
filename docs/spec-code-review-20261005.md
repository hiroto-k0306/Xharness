# 仕様書とコードの照合記録

2026-10-05。SPEC.md(§1〜§14)と実装の照合。対象: main `50e7707`(ブランチ `docs/spec-section5-auto-mode` の変更を含む)。

## 環境と実行結果

- Linux(クラウド)、Node v22.22.0、pnpm 10.34.6、`rg` あり、`pwsh` なし。Windows・GUI・exe作成・実API通信は対象外(SPEC.md §13)。
- `pnpm install --frozen-lockfile`、`typecheck`、`lint`、`build`、`build:headless` は成功。
- `pnpm test`: 146ファイル成功・4スキップ、1416件成功・29件スキップ(計1445件)。スキップはWindows専用・`pwsh`依存の試験。
- `format:check`: 照合前の main で `docs/` の4ファイル(`h3-job-investigation.md`、`h4-review-progress.md`、`m-codex-image-local-check.md`、`release-all-progress.md`)が未整形。今回は直していない。

## 照合の方法と範囲

- 各節の記述を、対応するコードの全文または該当部分を読んで確認した。挙動の一部は、一時ファイル・一時Gitリポジトリ・偽の依存で実際に動かした(権限判定、`webUrl`、ファイルツール、`AutoRefresh`・クールダウン、worktreeのマージ)。
- 実モデル通信、実資格情報、公式CLIの起動、MCPサーバーへの実接続、フックの実行は行っていない。
- 画面の見た目(§10のスクロール中の操作の固定・折りたたみ・色分け)と、レポートの詳細な内容は未確認。
- §4のうち、`agents/runner.ts` の子の実行の詳細と、トレース・レシートの記録は読んでいない。
- 前提ハッシュにモデルカタログ一覧が入る件(§3)は、コード読みでの確認で、再現は未実施。

## 見つかった食い違いと対応

仕様書に書かれていない挙動の追記が中心。仕様側の訂正・実装修正は次のとおり。

| 内容                                                                             | 対応                                               |
| -------------------------------------------------------------------------------- | -------------------------------------------------- |
| §5: 計画モードの記述(TodoWrite等は権限判定を通らない)                            | SPEC.md を訂正                                     |
| §10: Esc で実行を止めると書かれていたが、コードは止めない(`App.test.tsx` が固定) | SPEC.md・FEATURES.md を訂正                        |
| §8: 更新前の期限が読めないと、CLIが成功しても `unchanged` になる                 | `auto-refresh.ts` を修正、SPEC.md に判定規則を追記 |
| §6: Grep の rg 版が `id_ecdsa` / `id_dsa` を除外しない                           | `shell-search.ts` を修正し試験を追加               |
| §3: worktreeの競合マージで元リポジトリがマージ途中のまま残る                     | `repository.ts` を修正し試験を追加                 |
| §4: 未信頼のプロジェクト設定で `planApproval: auto` にできる                     | `definitions.ts`・`turn.ts` を修正し試験を追加     |

## 判断が残っているもの

- フォールバック(429)でセッションのモデルが保存され、元に戻らない(§7)。仕様に明記のみ。
- Claude の圧縮が Opus 5.5 / Sonnet 5.5 だけで、Haiku 4.5 では使えない(§7)。仕様に明記のみ。
- `FEATURES.md` の冒頭の対象リビジョン(`a7cb4fa`)は、この照合の時点の main と異なる。
