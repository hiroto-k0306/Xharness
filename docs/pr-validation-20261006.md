# ドラフトPR公開前の検証（2026-10-06）

ユーザーからこのリポジトリへの通常pushとドラフトPR作成の直接指示を受けて実施。マージ・auto-merge・リリース公開は対象外。

## 対象の確認

- 作業場所: `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness`。ブランチ: `review/integrated-release`。
- 開始HEADは指定どおり`95ab2c07f375acd7532a975ac2207125d96c016c`、未コミット変更なし。製品ソースは`0d46864`以降変更なし。
- originは`https://github.com/hiroto-k0306/Xharness.git`。fetch後のmainは`8bae697f8bb13fd4e11924d322b3c12a0e4b403d`。指定された旧main `4c7d5de`からの追加は「プロンプト」資料1件のみ。作業ブランチをリセット・上書き・mainへマージしていない。
- 開始時のPR比較差分は186ファイル、作業側の固有コミットは103件。旧評価コミット`678cf9d`はHEADの祖先ではなく、取り込んでいない。
- 対象ブランチのPR検索とリポジトリのopen PR検索はいずれも0件だった。

## 収録範囲と公開対象の点検

| 対象                 | 確認した実装・接続                                                                 |
| -------------------- | ---------------------------------------------------------------------------------- |
| 評価基盤             | token-usage、evaluation、固定課題、レポート、改善版比較と明示採用                  |
| 履歴検索             | project-history、同project境界、出典読取、親子・headlessへの接続                   |
| メモリ               | project-memory、候補と明示採用、版・出典の検証、管理UI                             |
| スキル               | project-skills、候補提示、資料参照、管理UI、明示load                               |
| 限定的な再開         | quota-pause、resume-conditions、承認・取消・保存境界と再起動の検証                 |
| モデル候補           | model-candidates、品質・欠測・鮮度、明示選択、同provider共有枠の扱い               |
| 結果受け渡し         | handoffs、確定結果の明示配送、atomic台帳、受信UI・headless                         |
| ローカルComputer Use | computer-use、local-browser-electron、内蔵固定ページの単一操作、intentと未確定停止 |

終了開始時の命令受付停止、改善操作中の権限固定、配布プロセス識別の修正と回帰テストも含まれる。自動モデル切替、自由な双方向セッション会話、任意サイト・PC全体のComputer Useの完成とは扱わない。

PR差分と公開される103コミットの変更パス・追加行を点検した。秘密鍵・アクセストークン形式・JWT・資格情報代入のパターン走査で得た3候補は、合成テストのダミー鍵2箇所と画像ファイル名の部分一致だった。認証ファイル、実ユーザーの会話ファイル、画面画像、生成exe、`.out`、実通信用一時スクリプトは含まれない。変更されたfixtureは合成した評価課題JSONだけ。資料にある過去の操作概要・数値・ハッシュと、生の会話・資格情報は区別した。

## 今回実行した検証

全回帰とGUIのrunnerはNode 24.16.0（`C:/Program Files/nodejs/node.exe`）を明示。シェルPATHはWindowsApps版pwsh 7.6.6を優先した。pnpmはローカル10.34.6。通常のpnpmスクリプトが使うNodeはローカル22.23.3だったため、型・lint・整形・buildの結果はこの版のもの。プロセス限定のPATHで、永続設定は変更していない。

| 検証                              | 今回の結果                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------ |
| typecheck                         | 成功                                                                                 |
| 通常のlint                        | 失敗。Git対象外`.out/approved-claude-refresh-20261006.ts:13:66`のno-explicit-any 1件 |
| lint（`.out/**`のみ除外）         | 成功。試験用ファイルは変更・実行していない                                           |
| format:check                      | 成功                                                                                 |
| headless / desktop build          | 両方成功                                                                             |
| 全Vitest初回（Node 24、rgあり）   | 179ファイル、1619成功・1失敗・skipなし、221.52秒                                     |
| 失敗ファイルの単独再実行          | model-candidates.integration.test.tsの3件成功、2.06秒                                |
| 全Vitest再確認（Node 24、rgあり） | 179ファイル・1620成功・失敗0・skipなし、196.29秒                                     |
| 開発fake GUI                      | 19成功・2skip、28.8秒。skipは配布exe復旧とportable専用                               |
| 固定課題のオフライン評価CLI       | 3課題×2構成の6実行。基準構成の合格と短い不完全実行の不合格を確認                     |

初回失敗はimprovements.fixture.tsの5秒待機で、期待idleに対してrunningが残ったもの。単独・全体の再実行では再現しなかったが、原因を断定せず初回失敗も残す。全回帰の再確認はビルド・GUIを並走させずに実施し、JSONのsuccess:trueと件数を確認した。今回、製品・テストコードは変更していない。rgなしの全回帰・配布版GUI・インストーラー作成は再実行していない。文書追記後に整形と差分検査を行った。

package scripts、Vitest/Playwright設定、GUIの一時home分離、mock認証・fixture通信、Git hookの有無を確認してから実行した。GUIは新規のfakeプロセスだけを使い、起動中の利用者アプリを終了・再インストールしていない。実AI通信、ログイン、認証更新は0回。秘密の資格情報ファイルを読んでいない。

ローカルログは`.out/pr-20261006-*`へ保存し、Git対象外とした。配布exe/portable GUI21成功、既存インストール更新、Codex Lunaの短文1回成功は**過去の結果**で、今回は再実行していない。Claude推論は過去も0回で未検証、本人の手動ログイン後の表示改善だけを確認済み。自動認証更新も未検証。

mainと作業ブランチに`.github/workflows`は存在しない。PR作成後にGitHubのstatus/checkも確認し、ローカル検証をCI成功とは扱わない。
