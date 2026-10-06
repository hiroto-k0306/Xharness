# 未コミット修正のレビューと配布版再検証（2026-10-06）

## 対象と保全

- 作業場所: `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness-connections`。
- 開始ブランチ: `feature/official-workflow-single-task`、HEAD: `4be02dfb9cbb935ae822f30a974baa3c4e5eafaf`。
- `Get-CimInstance Win32_Process`は今回は成功。対象のビルド・テスト実行はなく、残存NodeはCodexのMCP/CUA補助プロセスだった。アプリのタスク一覧でも他の稼働セッションなし。既存のインストール版XHarnessは操作・終了していない。
- 指定された保存patchのSHA256は`58bff8ffb4570c941055dad4934450699735664a6c1437783622b608b34743a9`。開始時の6追跡ファイル差分と新規2報告書・fixtureを確認した。
- 開始差分と新規ファイルを`.out/offline-review-20261006-original/`へ保全。reset・上書き適用・別ブランチ取込みなし。
- 今回はすべてfake/mock/一時ファイルによる検証。SDK/App Serverへの新しい実通信、認証操作、資格情報読取り、追加課金、native DAG実通信、インストール更新、push/mergeは行わない。

## レビュー結果と修正

現行SPEC §15と保存済み公式App Server 0.160.0の生成型を照合した。`GetAccountRateLimitsResponse.ordinaryUsageAllowed`は存在し、nullを割合・reset時刻から許可へ変えてはならない。通知は`rateLimits`のみの部分更新。新たな公式プロセスや実通信を起動せず、前回の生成物・マスク済みfixtureを使用した。

- 登録test IDを計画出力schemaのenumにし、検証器の未登録ID拒否を維持。
- 部分通知は公式readを同時1件・最大10秒で再取得。明示制限は停止、未知・失敗は確認不能として区別。creditsの存在だけで課金経路を推測しない。通常枠判定とChatGPT認証・個人plan・公式provider・標準速度・fallback無効の照合を分離。
- 遅い成功応答で新しい拒否を解除しない既存のabort判定を確認。
- **今回発見した競合を修正**: ツール許可の証跡保存と完了証跡保存のawait中にも通知が到着できた。許可返却直前・完了採用直前に再度quota待機を行う。待機中の新規通知→拒否を制御する2回帰テストを追加。
- 空・非構造化・tasksなし計画は1回で停止し承認しない。変更なし実装は実装1回で停止し、テスト・レビュー・自動再送へ進まないことを追加検証。
- 連続質問と説明だけの応答は各1回。実装・レビュー後の雑談はセッション入口のworkflow再作成と履歴継続を含めて、再実装・再レビューなしを検証。
- 最初のテスト案は完了済みruntimeを直接再利用し、`workflow_complete`を返すため1件失敗した。製品では`needsNewWorkflow`が再作成する。製品コードを変えず、正しいSessionController入口での回帰テストに置き換えた。

## 環境・検証記録

Windows環境。指定の`scripts/pnpm.ps1`を使用し、その子Nodeは22.23.3。システムNode24.16.0での結果と混同しない。シェル依存テストは子PATHにWindowsAppsを追加してユーザーのStore版pwshを使用する。永続PATH変更なし。package scripts、Vitest対象、GUIのfake home・専用PID終了、builderのpublish無効、Git hookの有無を確認した。

- 初回関連3ファイル: 124成功・1失敗（上記のテスト入口誤り）。修正後のSessionController会話回帰1件成功。
- 型チェック: 編集後に成功。
- 初回全体整形: SPEC.mdだけ不一致。対象ファイルにPrettierを適用。
- ローカルコミット初回: `git commit -m 'workflow: 登録テストIDの計画契約と有限停止を検証'`が`Author identity unknown` / `fatal: unable to auto-detect email address`で停止。作者情報をユーザーに確認中。OS権限拒否ではなく、権限・グローバルGit設定は変更していない。

コミット・配布物・ハッシュは作者情報の確認後に追記する。過去の実通信・旧配布物の成功を今回の成功には数えない。

### コミット待ちの最終ソースで実行した検証

| 検証                                        | 結果                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| 関連回帰                                    | 11ファイル161件成功、183.04秒                                    |
| typecheck / lint / format:check             | 成功                                                             |
| build / build:headless                      | 成功。今回esbuildアクセス拒否なし                                |
| 模擬GUI全体                                 | 24成功・2スキップ、1.7分。配布版専用2件は新規exe未作成のため別枠 |
| 全回帰                                      | 203ファイル1,838件成功、450.57秒。失敗・スキップなし             |
| ローカルコミット                            | 作者名・メールアドレスの回答待ち                                 |
| 新規portable / win-unpacked / 配布版2テスト | ソースコミット確定待ち。旧配布物を流用していない                 |

検証はローカルpnpm配下Node22.23.3、Store版pwsh7.6.6（解決入口は`C:/Users/ahwri/AppData/Local/Microsoft/WindowsApps/pwsh.exe`）。GUIの`NO_COLOR`/`FORCE_COLOR`競合警告あり。型・lint・整形とビルドのログは`.out/offline-review-*.log`、GUI証拠は`.out/offline-review-gui/`。

未コミット最終追跡差分`.out/offline-review-final-source.patch`のSHA256は`9a3b6aa10a330234263ecc43278e38d30fc93e74327d09e528cd777909e1ebdf`。新規会話回帰テストは`0ebca67e91df89bb9dbd7fe61bb484ba2733000eb303b40191aff5f1d8699f6f`。fixtureは開始時と同一。`.out/offline-review-source-hashes.json`に対応を保存した。コミット後の検証と偽って記録せず、現時点ではHEAD＋この差分に対する結果とする。
