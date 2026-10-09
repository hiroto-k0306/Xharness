> 過去の記録：移動元 `docs/official-workflow-live-20261006.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# 公式workflowの実通信検証（2026-10-06）

後続の直接承認により再確認方式を修正し、一方向の実レビューまで完了した。[使用量再確認の検証](official-workflow-quota-recheck-20261006.md)を参照。以下は最初の停止までの履歴であり、当時の未完了・確認待ちを遡って成功へ置き換えない。

## 対象・許可・保全

- 対象: `feature/official-workflow-single-task`、開始HEAD `4be02dfb9cbb935ae822f30a974baa3c4e5eafaf`。originは`https://github.com/hiroto-k0306/Xharness.git`。開始時clean、同じcheckoutを使う進行中プロセスなし。mainへの切替なし。
- 作業場所: `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness-connections`。
- 現行根拠: SPEC.md §15。ユーザーの今回の直接依頼により、公式Claude Agent SDK／Codex App Server自身の既存認証とサブスク枠で、固定の小課題を検証した。過去の模擬限定試験とは別の許可。
- Gitは所有者不一致（CodexSandboxOffline / ahwri）で初回拒否。ユーザーの追加許可後、対象checkoutだけをコマンドの`-c safe.directory=...`に指定。グローバル設定・所有者・ACLは変更していない。
- 起動中の旧インストールはPID 5068、`AppData/Local/Programs/XHarness/XHarness.exe`。画面を観測したが他ウィンドウに一部隠れ、全作業の終了可否を確認できなかったため終了しなかった。今回のモデル処理に旧アプリは使用していない。試験後も同PIDの存続を確認。
- 全試験は新しい一時合成Git repository／証拠ディレクトリ、GUIは固有`XHARNESS_HOME`で実行。既存設定・履歴のコピー、資格情報の抽出・コピー・編集、直接HTTPモデル通信、新規ログイン、追加課金、インストール更新、push、mergeなし。native DAGは有効化していない。

## 環境・接続

- Windows 11（buildログのOS `10.0.26200`）。実通信とVitestは`C:/Program Files/nodejs/node.exe`、Node 24.16.0。
- 公式子プロセス／受入テストでは、コマンド内の一時PATHの先頭をWindowsAppsにした。PowerShell 7.6.6、実体`C:/Program Files/WindowsApps/Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe/pwsh.exe`。永続PATH変更なし。
- repository-local pnpm wrapperは子プロセスにローカルNode 22.23.3を使用。typecheck/lint/build/packaging/Playwrightはこの経路。全項目をNode 24で行ったとは扱わない。
- Claude: `@anthropic-ai/claude-agent-sdk@0.3.290`のqueryと同SDKのaccountInfo／Usage／supportedModels。firstParty・subscription・Extra Usage無効を送信前に確認。SDK自身が管理する認証のみ。
- Codex: `C:/Users/ahwri/AppData/Local/OpenAI/Codex/bin/8aaf1547b825b104/codex.exe`、`codex-cli 0.160.0`、専用`app-server --stdio`。account/read（refreshToken:false）、account/rateLimits/read、model/list、ephemeral thread/start、turn/start。ChatGPT認証と通常枠許可・追加creditsなしを事前確認。既存daemonへの接続なし。
- 独立したcatalog確認1回、その後workflow準備2回を各providerで実行。これらはモデル入力なし。query直前の経路・枠確認は別途行われる。下表はXHarnessのモデル入力の送信単位であり、SDK内部のHTTP回数ではない。

## 実通信の結果

初回は指定HEADそのまま。2回目は同HEADに今回の計画スキーマ修正を加えた作業ツリー。ソース差分の保存先`.out/official-live-20261006-source.patch`、SHA256 `e00e83cb7a331a7eef566ac60ca0221ffac0f0d2e001a6c8dbb4bd90284caac7`。

| 試行・段階       | 接続／指定モデル                  | 実際の観測モデル                                    | 状態                                |     In |   Out | 使用量の完全性     |
| ---------------- | --------------------------------- | --------------------------------------------------- | ----------------------------------- | -----: | ----: | ------------------ |
| 初回・計画       | Claude SDK / opus high            | claude-opus-5-5、SDK内部のclaude-haiku-4-5-20251001 | 応答成功、計画検証はunapproved-test | 17,745 |   854 | query-pipeline完全 |
| 修正後・計画     | Claude SDK / opus high            | claude-opus-5-5、SDK内部のclaude-haiku-4-5-20251001 | 検証・計画承認成功                  | 18,052 |   834 | query-pipeline完全 |
| 修正後・実装     | Claude SDK / haiku、effort null   | claude-haiku-4-5-20251001                           | 実装成功                            | 47,803 | 1,533 | query-pipeline完全 |
| 修正後・レビュー | Codex App Server / gpt-6-luna low | gpt-6-luna                                          | 送信後quota-paused、レビュー未確定  | 10,828 |    62 | 部分値のみ         |

モデル入力は合計4回（Claude 3、Codex 1）。Inの既知合計94,428、Outの既知合計3,283。4/4で数値取得、完全usageは3/4。Codexの最終値は欠測し、cache-writeもnull。AnthropicのInはcache-read/writeを含み、reasoningはOutに含める。料金やサブスク枠への換算なし。Opus計画のSDK集計にHaikuも含まれたため、Opusだけの使用量とは表示しない。

修正後に承認した計画は`add.mjs`の`a - b`を`a + b`へ直す1ファイルの課題。`acceptance.test.mjs`は変更せず、登録ID`arithmetic`を用いる。承認digestは`bf3c473a06865b55509a7e1109dc96f740f5090a311f9923fbe4943312870019`。

合成repositoryのbase `061060ed377f05768c1574b25de896a590f504e8`、実装commit `400cc64f5b82471479364aa4df1c14cd3269a141`。XHarnessの独立した`node --test acceptance.test.mjs`はexit 0、1件合格。この固定base/head差分をCodexへ送った。レビューのfindings確定、修正・再レビューには到達していない。逆方向は未実施。

## 発見した問題と修正

### 計画のacceptanceフィールド

生成スキーマは任意string配列、検証器は登録test IDのみ受理しており、初回応答は`unapproved-test`となった。未登録IDが含まれたことは検証経路から確認できるが、拒否したstructured outputそのものは保存しない実装なので、具体的な文字列は後から確認できない。コマンド文字列を返したと断定しない。

`contracts.ts`に登録test IDをenumとする計画出力schemaを追加し、単一タスクruntimeに適用。入力の説明にもIDを指定するよう明記。既存の範囲・テストID検証は緩めない。回帰テストは送信schemaのenumと既存の不正計画拒否を確認。修正後のOpus計画は検証を通った。SPEC §15の既存要件内の修正であり、仕様変更なし。

### Codexレビューの使用量通知

事前の通常枠確認はtrue。送信後の`account/rateLimits/updated`を現実装で解釈するとallowed:null、primary使用率60%となり、即時停止した。これはサーバーが残量不足を明示した結果ではない。XHarnessが通知から課金経路を証明できず停止した結果。モデルの出力トークンは受信したが、レビュー結果は採用していない。

[公式App Server資料](https://learn.chatgpt.com/docs/app-server)の通知例はrateLimitsだけを含み、read応答と同じフィールドを保証していない。今回の記録は正規化済みでraw通知を保存していないため、欠けた全フィールドの断定はしない。`codexQuota`がread応答と通知に同じ必須条件を課している点を確認した。

不足通知に対し公式account/rateLimits/readで再確認し、明示的な通常枠許可・追加課金なしを確認できた場合だけ継続する案を提示した。これは現行の即時停止動作を変えるため、AGENTS.mdに従い承認を確認中。今回の時点では変更・再送していない。送信済み未完了callのためresumeBlockReasonは`uncertain-effect`。保存記録を改変して再開可能にすることはしない。

## オフライン・画面・配布検証

| 検証                                        | 結果と範囲                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 公式workflow＋IPC、修正前                   | 9ファイル62件成功、131.66秒。Node24 / WindowsApps pwsh。モデルはfake/mock                                           |
| 修正後runtime回帰                           | 1ファイル16件成功、31.60秒。新enum確認、双方向・修正・再開・不正計画拒否を含む                                      |
| typecheck / 全体lint / 修正ファイルPrettier | 成功                                                                                                                |
| Electron build                              | 開始時、修正後とも成功                                                                                              |
| 修正後の通常GUI single-task                 | 1件成功、20.1秒。模擬双方向、取消、復元、承認、修正、レビュー。実通信GUIではない                                    |
| portable分離                                | 成功、25.2秒。固有fake homeと固有展開先、片方を閉じても他方の資源・履歴が維持される                                 |
| packaged再起動・異常終了復旧                | 成功、3.6秒。試験専用プロセスだけを異常終了させ、履歴保全・未確定処理の再実行拒否を確認                             |
| 実通信HTML表示                              | 保存JSONとstatus・3call・In/Out・完全usage 2/3が一致。Edge headlessの隔離コンテキストで描画しスクリーンショット確認 |

`.out/packaged-4be02df-build.log`の過去のesbuild上位ディレクトリAccess deniedを確認した。今回は現ユーザー権限のままbuildと`electron-builder --win portable --publish never`が成功。ACL変更なし。配布物は最初のbuild（未修正4be02df）から作成し、その2件を検証。配布物に今回の計画schema修正が入ったとは扱わない。インストーラの作成・既存版への上書きなし。

- `dist/win-unpacked/resources/app.asar` SHA256: `70cc204b9281a183c678d24fa53b2592b69fedee94e7e5ec7302ed436ba1fbe7`
- `dist/XHarness-0.0.0-portable.exe` SHA256: `e6449c29bb9b059ff7a708134e51b43007d2139edc6730dc61b8682b67338f68`

Playwright標準headless Chromiumは未インストールで初回のHTML描画が失敗した。ダウンロード・設定変更はせず、既存EdgeでHTML描画のみ確認した。モデル実行経路の変更ではない。GUIにはNO_COLOR/FORCE_COLOR競合警告、packagingにはauthor未指定と他OS/arm64任意dependency未同梱の警告あり。Windows x64 fake配布試験は成功したが、配布物内SDKの実通信は未検証。

## 証拠と未完了

- 初回: `C:/Users/ahwri/AppData/Local/Temp/xh-official-evidence-BSOIkW/{workflow.json,report.html,traces/}`。
- 修正後: `C:/Users/ahwri/AppData/Local/Temp/xh-official-evidence-9swxXv/{workflow.json,report.html,traces/}`。合成workspaceは`C:/Users/ahwri/AppData/Local/Temp/xh-official-workflow-sC5SGy`。
- `.out/official-live-20261006-{summary.json,report.png,offline.log,regression.log,lint.log,build.log,gui.log,packaged.log,source.patch}`。証拠はローカルのみ。秘密値・raw nativeログ・thinkingは保存していない。
- 一方向のE2E完了は未達。到達範囲は実計画→承認→実装→客観テスト→Codexレビュー送信→枠情報不足による停止。
- 実通信は開発CLIから実行した。実通信を通常Electronパネルの最初から最後まで操作する経路は未実施。画面の確認は実記録HTMLと、別途模擬GUIであり区別する。
- 全体Vitest・全体GUIを今回再実行したとは扱わない。逆方向の実通信、指摘修正・再レビュー、native DAG並行、配布版SDK実通信は未実施。
- 追加ログインや認証設定変更は不要だった。自動認証更新機能の検証ではない。SDK/App Server内部の認証更新有無は観測していない。
