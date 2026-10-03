# 早期の送信準備キャンセル（2026-10-03）

起点は最新 `origin/main@ff538588df39cfb26ebdc8bac560b9c86d987b97`。
開始時のcheckout `codex/security-session-boundaries@2e4ab19` と起点のソース差分はなく、作業ツリーはclean。
新規ブランチ `fix/early-send-cancellation` を起点から作成した。

以前の4件（Git設定による外部実行、worktree操作との競合、削除済み履歴の復活、再開時のsystem/tools照合）はPR #6で取り込み済みであり、再実装していない。

## 確認した問題と修正

SessionControllerの送信準備は、最初の非同期処理より前にsessionBusyを予約する一方、AbortControllerと終了待ちPromiseの登録は設定・履歴の読み込み後だった。
その読み込み待ちにabort、close_session、shutdownが届くと、停止操作の後に通常の送信が開始される。
修正前の独立したオフラインprobeで、履歴読み込みにbarrierを置き、3操作の後に各1回の模擬Provider呼び出しが発生することを確認した。

- 最初のawaitより前に準備用AbortControllerと終了待ちPromiseを登録する。
- abort、close_session、shutdownは準備をキャンセルする。shutdownは準備の完了も既存の終了待ち対象に含める。
- 設定・履歴読み込み後にキャンセルを確認し、キャンセル済みの準備からターンを開始しない。
- 通常ターンには同じAbortControllerを渡し、既存の権限待ち・実行中キャンセルを維持する。
- `/stop`は設定読み込みを待たずにキャンセルする。予約用のAbortSignalも準備開始時から結び付ける。
- 準備終了時に予約・listener・完了待ちを解放し、停止後の通常送信を妨げない。

## 検証

新規 `early-send-cancellation.test.ts` は設定／履歴読み込みの2地点とabort／stop／close_session／shutdownの4操作を組み合わせた8ケース。
いずれも読み込み待ちのbarrierを使い、キャンセル後のFakeProvider呼び出し0回、JSONL生成なし、shutdownの準備完了待ち、停止後の再送を確認する。

- 初回関連4ファイルは39テスト成功。その時点では新規8シナリオを2テストにまとめていた。
- 新規テストのworkspace取得結果に型の絞り込みを追加し、8シナリオを個別テストに分けた。
- 最終関連14ファイル・128テスト成功、失敗／スキップ0。`--project node --maxWorkers=2`。
- 全体TypeScript型チェック、ESLint、electron-vite build成功。変更ファイルのPrettier、git diffチェックも確認する。

対象ファイルはearly-send-cancellation、session-boundaries、offline-review、schedules、controller、premises、premises-compact、stable-prefix、llm-calls、store、slash-controller、rewind-command、phase4、git-read-boundaryの各test.ts。

Node.js 24.16.0で直接ローカルのVitest／TypeScript／ESLint／electron-viteエントリーポイントを使用した。
package.jsonとビルド設定を確認し、install・postinstall・dev・preview・headless実行はしていない。
テストプロセスには既存のプロセス内offline guardを事前ロードし、fetch／HTTP(S)／TCP／TLS通信とCodex／Claude CLI起動を拒否した。
モデルにはFakeProvider／注入モックのみを使い、Gitの試験は隔離したローカルfixtureを使用した。システムのネットワーク・セキュリティ設定は変更していない。

## 検証範囲の限界

実プロバイダー・認証・実CLI・ライブアプリ・exe作成・インストール済みアプリ操作は未実施。
全テストスイートは実行していない。既存4件の実APIでの再開／圧縮の制限は既存のsecurity-session-boundaries-progress.mdに記録されている。
ビルドは静的な生成のみであり、アプリ起動を伴わない。pushとmergeは行わない。
