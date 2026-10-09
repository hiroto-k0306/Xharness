> 過去の記録：移動元 `docs/workflow-environment-fix-live-20261009.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 公式コマンド環境と承認時計の修正・実アプリ再検証

2026-10-09、Windows、feature/native-workflow-boundary。開始HEAD e45593e、既存の未コミット調査報告を保全。SPEC §15の120秒（承認待ちを除く）、環境と秘密の境界を維持する不具合修正。利用者の「修正して再度実アプリで検証」に対応。

## 修正とオフライン検証

- runtimeEnvironmentにPATHEXTを追加。APIキー・NODE_OPTIONS・PSModulePath等を引き継がない境界は維持。
- pwsh管理プロセスが子の起動直前にPSModulePathを取り除き、後続シェルが自身の版に合う探索先を初期化する。管理プロセスのJob・子孫回収を緩和しない。
- 承認待ちの重なりを数えるphaseTimerへ変更。最初のpauseだけで経過時間を差し引き、最後のresumeだけで再開。終了後の遅延応答で時計を再設定しない。

修正前後の同じダミー起動probeで、node / git / pwsh / Get-FileHashは4項目とも未検出から検出へ変化。実モデル通信は0回。管理用pwshはCodex依存の7.6.5（Store版ではない）、probe Nodeはホスト24.16.0。

scripts/pnpm.ps1、ローカルNode22.23.3による最終変更範囲の確認：owned-process / workspace 12件、codex / phase-timer 81件、計93件成功。後者は既存Codex75件と新規時計6件。typecheck、変更7ファイルのESLint、通常build成功。全回帰は実行していない。

## 配布・実アプリ検証

環境修正254f55b、時計修正3627b89をローカルコミット。配布元は3627b891892c67f1bd3181e6d2b46f7a6a684d1f（clean）。electron-builder --win nsisは終了0。出力先はD:/AIwork/XHarness-release/XHarness-command-environment-3627b89-20261009/。上書きせず新しい出力先を使用した。

旧アプリの入力が空で作業がfailedであることをUIで確認して通常終了。silent per-userインストールは終了0。exe / app.asar / SDK seedの配布・インストール先のハッシュ一致。更新前後の設定・履歴965ファイルのSHA256一致、alpha.20の固定指定も保持。配布側・インストール先それぞれの隔離fake起動GUI各1件成功。通常起動後は既存プロファイル・作業場所で検証した。

| 配布物                   | SHA256                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| XHarness-Setup-0.0.0.exe | 84cd7033a684da949689ce697e424ac8a0e96bc350e18f813a80bc5478489d06 |
| XHarness.exe             | 907a314520e431efeb9c3bd67e9c8ed4721710b8b13e5f4d3c728e750963f9b5 |
| app.asar                 | 2912590234046dc17e60793e2367f66215a4a6802638a0b0b657fb460541c6a1 |

配布先のsource-manifest.jsonとinstalled-verification.jsonは配布・更新時点の記録（liveCalls=0）。以下の実通信結果は別の後続検証であり、その値を成功済み通信回数に読み替えない。

## 実通信の結果

新規workflow 855a523c-b565-40ae-b0f5-cab9b0fe5b0aを実アプリの通常入力から1件だけ開始。課題は、node / git / pwsh / Get-FileHashを確認し、新規docs/codex-environment-live-check-20261009.mdだけに実測値を書くこと。背景資料の追記やソース変更はさせなかった。今回の利用者依頼に基づき、表示計画の範囲を照合して実アプリで承認。承認digestは9c0e9898cef24b37f1643e0aea0ce7f356325c2948a25f74612fb19182bea262。既存の自動モードのフロー許可を使用し、禁止操作・sandboxは維持。

| 工程           | 指定・観測主モデル     | 所要時間  | 結果      |
| -------------- | ---------------------- | --------- | --------- |
| 判別           | Claude Haiku 5.5       | 7,351 ms  | completed |
| 計画           | Claude Opus 5.5        | 32,898 ms | completed |
| 実装           | Codex gpt-6.1-sol low  | 58,656 ms | completed |
| 別会社レビュー | Claude Opus 5.5 medium | 23,220 ms | completed |

保存状態completed / next=complete / errorなし、修正工程0回。UIの完了表示と一致。Codexコマンド8件は全件completed / exitCode 0、fileChangeは新規文書1件。Node v24.16.0、Git 2.54.0.windows.1、実行シェルPowerShell 7.6.5、pwsh経由のSHA256取得成功。ハッシュ1225E01C1B83100CCFBB51EE26676581BDEBE1B9D848C86A40EB395187B8376Bは検証時点の背景文書のホスト測定と一致（本報告の追記前）。従来のコマンド未検出・起動準備失敗誤分類・約47.6秒の早期timeoutは再発しなかった。今回の壁時計58.7秒だけで120秒境界の厳密性やあらゆる並行要求を実証したとはしない。重なった承認の時計は偽時計回帰で確認。

Claudeレビューはnit 3件、重大指摘なし。内容はpwsh検出の説明、シェル式の終了コード表現、レビュー未実施の時点説明。レビュー後に新規文書の説明を補足・整形した（追加モデル送信なし）。保存済みのレビュー対象はその直前の固定差分で、後の文書整形を再レビュー済みとはしない。

公式Claude Agent SDK 0.3.293と固定Codex CLI 0.162.0-alpha.20のApp Serverを使用。ClaudeのSDK初期モデルとparent_tool_use_id=nullの主assistantは判別Haiku、計画・レビューOpusで一致。計画・レビューのresult.modelUsageには別途Haikuの利用量もあるが、モデル名集合からその役割を推測しない。

| 工程／usageモデル | In（非cache） | cache読取 | cache作成 | Out   |
| ----------------- | ------------- | --------- | --------- | ----- |
| 判別／Haiku       | 5,043         | 0         | 9,071     | 711   |
| 計画／Haiku       | 3,243         | 0         | 0         | 324   |
| 計画／Opus        | 6             | 25,347    | 5,938     | 2,880 |
| レビュー／Haiku   | 5,480         | 0         | 0         | 319   |
| レビュー／Opus    | 4             | 11,318    | 13,673    | 1,951 |

Codex thread累積In112,942（内cache67,072）/ Out1,812 / total114,754、complete=true。cacheを入力へ再加算しない。各Claude query-pipelineもcomplete=true。ハーネスの工程呼出は4回で上限8以内。SDK／App Server内部のHTTP往復回数は欠測で、「モデルへのリクエストが厳密に4回」とは扱わない。認証は公式基盤が扱う既存の正規認証。資格情報抽出・コピー、直接HTTP、追加課金や権限変更、新規認可、手動ログインは行っていない。

これは文書課題の実通信確認で、通常作業のモデル報告と別会社レビュー。checksは空で、独立プロセスのプロジェクトテストや全回帰の成功を主張しない。手元で追加確認が必要なのはStore版pwsh、他のPC環境、長時間・取消・再起動を伴う実通信。portable／recovery、全GUI、headlessビルドは今回追加実施していない。修正元の製品コードは配布後に変更していない。アプリは完了状態で起動したまま保全。push・mergeはしていない。
