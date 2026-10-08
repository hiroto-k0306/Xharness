# 通常作業の公式ツール探索への変更

- 日時：2026-10-09 JST。作業場所：D:/AIwork/Xharness。
- ブランチ：feature/native-workflow-boundary。
- 開始HEAD：27810dc2065a30501efea1393437676facc89175（開始時clean）。実装HEAD：e8f8f5f5e9d55cef2370afdba792826032f92e38。この記録を追加するコミットは文書のみ。
- 利用者が、事前ファイル・既存テスト1件・clean Git・Vitest版・独自のツール制限を外し、公式エージェントへ探索・実装・検証を任せる変更を承認した。現行仕様はSPEC.md §15冒頭。固定合成課題／明示的な登録テストの経路は保持。
- 実通信・認証更新・ログイン：0回。push・merge・配布作成・再インストールは未実施。既存のインストール版27810dcは今回変更していない。

## 停止記録から分かったこと

以前の `.gitattributes` の一律拒否と既存JSテスト不在での停止はXHarness側の前提条件だった。直近の対象自動提案は71msでfailed、dispatched=false、SDK初期化・モデル・ツール・usageの証跡がなかった。詳細エラーは未保存で、失敗原因は断定できない。最初の判別は通信済みだったため、作業停止を「一切送信していない」と扱わない。モデルの不正出力だったとは断定しない。過去の認証・公式ヘルパーの問題まで同じ原因とは扱わない。

通常作業から対象自動提案queryと固定テスト探索・Git事前検査を外し、判別1回の後にメインモデルの計画へ直接進む。未知の例外は安全な固定コード、構造化出力不正はphase別のコードで保存する。旧停止の内部原因を解明したとは扱わない。

## 実装

- session.cwd／既存worktreeで計画・実装・レビュー。非Git、既存テストなし、Vitest未インストールでも計画できる。新しいworktree・コピー・Git初期化・自動コミットは作らない。元の選択フォルダーへ直接編集することを計画画面に明示。
- 開始時の既存編集を含むファイル内容を基準とし、承認前後で変更を照合。固定before/afterの差分を別会社のモデルへ渡し、最大2修正／計画以降7呼出まで。変更なしはfailed。履歴の再表示は可能だが自動再開しない。
- Codexのnativeツールとworkspace sandboxを維持。通常作業の未登録コマンド・複合式は全文を個別承認へ渡し、安全と自動認定しない。ファイル候補以外の領域内編集を許可する。境界テストで見つかったunsafe-path例外は明示的なdeclineに変更。
- Claudeの領域内Read/Glob/Grep/Edit/Write/NotebookEditと、個別承認付きBashを使用。拒否・期限切れ・取消・内容変更で停止。承認中はphaseタイマーを停止。バックグラウンドBashと子委託は無効。
- テストはモデルの実行報告としてnativeValidationに保存し、process/checksを捏造しない。未実行を明記。GUI・LoopFlow・HTML・結果受け渡しで出典を区別し、通常作業の最終レビューと承認を照合。
- 認証・通常枠・追加課金禁止・旧HTTPへの暗黙fallback禁止は変更しない。資格情報や思考本文を記録しない。

## 環境・オフライン検証

Windows 10.0.26300。pnpm 10.34.6（scripts/pnpm.ps1経由）。リポジトリのpnpm shimと通常チェックのNodeは .tools/node_modules/node/bin/node.exe / 22.23.3。主環境に合わせた関連試験は C:/Program Files/nodejs/node.exe / 24.16.0 をpnpm execで明示。利用したpwsh探索結果はCodex同梱版 C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe / 7.6.5。WindowsApps／Store版pwshでの新方式の成功は未確認。

| 最終確認                                                                                                                                                           | 結果                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 通常作業runtime、automatic-session、vitest-session、Claude/Codex模擬adapter、command/operation承認、handoffs-official、WorkflowFlow/OfficialWorkflowPanel：Node 24 | 10ファイル214テスト成功、19.59秒。FakeProvider／SDK・App Serverモックのみ                    |
| Node 22互換の同じ関連範囲                                                                                                                                          | 追加のCodex境界3件より前の211テスト成功、23.89秒。最終214件をNode 22で再実行した結果ではない |
| typecheck / lint / build / build:headless                                                                                                                          | 最終実装で全て終了コード0                                                                    |
| Prettier / git diff --check                                                                                                                                        | 変更範囲成功                                                                                 |
| 開発GUI：automatic-workspace / official-session / smoke                                                                                                            | 最終ビルド、隔離fake homeで3件成功、4.3秒。実モデル通信なし                                  |
| 実リポジトリの比較基準取得                                                                                                                                         | 読み取りのみで873ファイル取得成功。モデル送信なし                                            |

実装途中の広い関連試験は40ファイル440件中437成功・3失敗、564.71秒。Claudeの拒否／内容変更2件は実装途中の旧動作で失敗し、最終214件では成功。既存の模擬DAGの `corrects an explicit synthetic integration review finding and rechecks both providers` は30秒timeout。Node 24の単独再確認でも同じtimeout（31.71秒）で、解決済みとはしない。単独再確認の10 skipはtestNamePatternによる対象外。native DAGは引き続き無効。全リポジトリ回帰ではない。

## 未確認・限界

実SDK/App Serverでの探索・任意のテストコマンド・承認待ち・別会社レビューは未確認。配布exeの作成／起動／再インストールも未実施。次の実通信は別途利用者の範囲・予算承認が必要。既存の設定・履歴・認証は変更していない。

既存編集の保全は指示と基準照合であり、モデルが触れた全副作用の自動復元保証ではない。公式sandboxと個別承認を維持しても、shell全文の意味や秘密参照を完全に静的解析する保証はない。ClaudeのBashはOS全体の完全隔離を追加したものではない。比較対象は秘密名・リンク・依存物・生成物等を除外し、10,000ファイル／8 MiB毎ファイル／128 MiB合計／深さ40、レビュー内容4 MiBまで。上限・読み取り不能は停止する。テスト報告は自己申告であり、ハーネス独立検証・未テストの品質保証ではない。

保存作業場所や使用量・公開イベントの確認は継続するが、SDK内部の全HTTP往復・非公開思考を取得する機能ではない。
