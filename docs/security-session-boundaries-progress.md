# Git とセッション境界のレビュー対応（2026-10-03）

- 最新 `origin/main`: `dfaea555c82fb7ac707062d06d440d787c54214c`。開始時の作業ツリーは clean（退避すべき未コミット変更なし）。ここから `codex/security-session-boundaries` を作成した。
- 既存処理を追い、今回の4件はいずれも残っていた。前回の修正・L1〜L4は再実装しない。
- package.json、Vitest / electron-vite 設定、Git hooks を確認。pretest / prebuild なし、Git hooks は sample のみ。インストール・アプリ起動・認証・実プロバイダー通信は行わない。

## 1. Git 読み取りの外部実行

- Git の status / diff / log / show は plan / 広い allow / 常に許可でも ask。危険オプションは既存の plan 拒否を維持する。ユーザーが承認したコマンドは任意の設定を実行しうるため、サンドボックス化したという意味ではない。
- 内部 Git は `--no-pager -c core.fsmonitor=false` を付け、内部 status の fsmonitor 実行を防ぐ。内部に diff / show / log の external diff / textconv を用いる経路はない。
- 隔離した一時 Git の無害な fsmonitor スクリプトで再現。内部 status は実行せず、明示した通常 Git status は marker を作ることをテストする。
- 初回検証: 権限関連3ファイル、78テスト成功。内部 Git 対策追加後の検証結果は後述。
- 集約検証で trust / Phase 4 の2件が確認待ちのタイムアウトになった。Git が常に確認対象になったため、従来の「allow が適用される」結合試験は pwd / Get-Content のダミーへ変更し、本来の信頼・永続ルールの検証目的を維持した。新たに external diff / textconv の設定経由の無害なスクリプト実行も一時 Git で確認する。

## 2. 送信準備と worktree 操作の排他

- 最初の await より前にセッションを予約し、送信準備の終了まで保持。worktree 操作も同じ予約を取得する。マージの親ワークスペースの writer 判定にも準備中を含める。
- 停止入力は予約を迂回して中断できる。実行中は従来の runtime.status が担当する。
- 履歴読み込みと削除完了をそれぞれ barrier で待機させ、両順序の競合を再現するテストを追加した。
- 初回関連テストはエラー文言の違いで1件失敗（排他自体は動作）。既存の「Turn already running」を維持するよう修正し、再検証する。
- 修正後は競合・停止・圧縮・予約の3ファイル32テスト成功。初回型チェックの追加テストの id / this 型不足も修正し、型チェック成功。
- 最終点検で、別セッションの worktree 操作が履歴読み込み中にルートを予約する場合も送信直前に再確認するようにした。予約機能の busy 判定にも共通の準備予約を加え、準備中に期限が来た予約を誤って終了しないようにした。barrier と fake timers の追加回帰試験は、圧縮・予約と併せた3ファイル30テストで成功。

## 3. 削除済みセッションの復活防止

- 削除も送信準備と共通の予約を取得し、準備中・実行中の削除を拒否する。
- SessionStore は最初の await 前に tombstone を付けて一覧から除外。セッションごとの保存・履歴追記・削除を直列化し、先行する書き込み完了後に削除する。削除開始後の古い save / append は破棄する。
- barriers で履歴読み込み中の削除、削除中の送信、先行保存の待機中に届く削除と遅延保存・追記を確認。通常削除後も index と JSONL が消えたままであることを検査する。
- 4ファイル42テスト成功、型チェック成功。実行中ターンの削除は従来どおり拒否する。排他・tombstone は同じアプリの SessionStore に対するもの（複数アプリで同じ保存先を同時利用するためのロックではない）。

## 4. 保存履歴と送信前提の照合

- §24 の固定前提を再起動後も照合する。workflow が加える system / tools を含め、実際の送信直前の SHA-256（v1）だけを索引に保存する。本文・ツール定義・資格情報・セッション中の許可は追加保存しない。権限ルールは現在の設定から適用する。
- 同一前提は再開できる。AGENTS / tools / workflow が不一致、または assistant を含む旧形式の履歴は main の送信・自動圧縮より前に停止し、新規セッションを案内する。元の履歴は保持する。user のみの旧履歴は新しい前提を設定できる。
- Claude の手動圧縮は、メモリ上の検証済み effective prefix を使用。再起動直後は未照合なので先に通常ターンを実行するか新規セッションを使う必要がある。Codex の別 system による要約にはこの制約は不要。
- 実際の Claude による不一致拒否は未検証。今回の確認は FakeProvider / モックのみ。
- 初回関連テストで1件失敗：既存の再開・履歴読み込み競合テストが、再開時に Read を削除していた。元と同じ tools に揃え、競合の検証目的を保った。再検証は6ファイル84テスト成功。追加の権限変更テストと圧縮テストは最終検証に含める。

## 最終検証

- Windows 11（OS build 26200）。Node `24.16.0`: `C:/Program Files/nodejs/node.exe`。互換確認 Node `22.23.3`: `.tools/node_modules/node/bin/node.exe`。Git `2.54.0.windows.1`。
- 初期の小範囲の試験は Codex 同梱 pwsh `7.6.5` が PATH の先頭だった。最終集約と Node 22 の再検証は `C:/Users/ahwri/AppData/Local/Microsoft/WindowsApps/pwsh.exe`（`7.6.6`）を PATH の先頭に指定し、ユーザーの配布形態に合わせた。
- Node 24: 明示した65ファイル、**539テスト成功・失敗0・スキップ0**（`--maxWorkers=2`）。core / agents / workflow / checkpoints / config / context / session / tools を対象に、provider-compactor、report-trace、mcp-session、authentication、web 系の試験をファイル一覧から除外して実行。Phase 4 は fixture と注入 fetcher のみで通信しないことを確認して含めた。
- 再現コマンド（PowerShell、上記 Node / pwsh の PATH を指定して pnpm を使う）:

```powershell
$boundaryTests = @(rg --files src/main/core src/main/agents src/main/workflow src/main/checkpoints src/main/config src/main/context src/main/session src/main/tools -g '*test.ts' | Where-Object { $_ -notmatch '(provider-compactor|report-trace|mcp-session|authentication|web[^\\]*)\.test\.ts$' })
pnpm test @boundaryTests --maxWorkers=2
```

- 初回の集約は Vitest の project に CLI の exclude が適用されず、72ファイル619テストを実行（616成功・3失敗）。混入した試験も注入モック / fixture / localhost のダミー MCP であり、実際の資格情報・CLI・モデル API は使用していない。最終検証では除外を正確にするため、glob 除外に頼らずファイルを明示した。
- その3失敗は上記 Git の確認待ち2件と、画像圧縮試験の負荷時5000msタイムアウト1件。Git の試験前提を修正し、並列数2で再検証すると3ファイル11テスト成功。タイムアウトを隠すための実装変更やスキップはしていない。
- Node 22: Git 境界、セッション境界、前提照合、Claude 圧縮モック、offline-review、schedules、handoffs、powershell-command、background-shells の9ファイル、**80テスト成功・失敗0・スキップ0**。Windows Job / 子孫プロセスの既存テストも含む。
- 最終変更後の `pnpm typecheck`、`pnpm lint`、`pnpm build` はすべて成功（Node 24）。ビルドのみで、アプリ・exe・認証 CLI は起動していない。pnpm は既存の `pnpm.onlyBuiltDependencies` フィールドを無視する警告を出すが、依存設定は変更していない。
- 新規の通信関連回帰試験は fetch を例外に置き換え、FakeProvider / 自作 Provider モックのみを使った。手動 Claude 圧縮は3テストで workflow の system / tools 一致、元の JSONL 保持、復元直後・旧形式での通信拒否を確認した。実応答を取得したという意味ではない。
- scripts / auth / providers / spike / headless / UI の全試験は実行していない（アプリ起動・CLI・認証・実プロバイダーの禁止を守るための保守的な範囲設定）。未適用の修正スクリプトは実行していない。

## 制限と手元で実施が必要な確認

- Git のユーザー承認は外部ヘルパーの安全性を保証しない。承認後はコマンドとリポジトリ設定が適用される。内部 Git の書き込み操作は既存の明示承認を維持する。
- 排他は同一アプリ内。複数プロセスから同じ home を同時に開く用途は保証しない。
- assistant のある旧履歴や前提不一致は新規セッションへ移行する。既存の履歴の閲覧・レポート出力はできるが、自動的に旧 system や権限を復元しない。Claude の再起動直後の手動圧縮には上記の制限がある。
- 実際の Claude が今回の再起動の不一致を拒否するか、実モデルでの再開・圧縮、GUI操作は未検証。実 API 送信はこの依頼の範囲外。
- 手元で実施が必要: 通信しない fake モードの GUI で Git の確認表示、削除中の送信拒否、AGENTS 変更後の再開案内と `/clear` を確認する。今回は自動接続の可能性があるアプリを起動しない条件に従い未実施。
- 通常 push 後にリモートのブランチ SHA とローカル HEAD を照合する。main へのマージは行わない。
