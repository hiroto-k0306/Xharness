> 過去の記録：移動元 `docs/codex-prerelease-live-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# Codexプレリリース指定と実アプリ検証（2026-10-08）

## 対象・境界

- ブランチ `codex/loopflow-workflow-ui`、基準HEAD `27262a3bea4ff0840604a23036a1534b5345c90d` と既存未コミット差分。今回の配布コードはHEAD単体ではない。既存変更を保護し、push・merge・上書きインストールは行わない。
- Windows 10.0.26300、テスト/独立テストはNode 24.16.0。作業シェルはCodex同梱pwsh 7.6.5。App Serverが実行した読み取りはWindows PowerShellのラッパーで、pwshの成功とは区別する。
- ユーザーが今回の実通信と各検証20回を承認。計画・個別許可は実アプリを操作。隔離homeと合成Gitリポジトリを使用。公式SDK/App Serverが既存の正規認証を扱う。資格情報の抽出・コピー・編集、新しい認可、追加課金への切替、OS権限設定の変更、native DAG有効化は行っていない。
- Codexデスクトップとnode_replを起動したまま検証した。無関係なプロセスは終了していない。試験アプリの切替は通常終了。失敗した自前の無画面診断プロセスのみ終了した。

## CLIのインストール・実画面での指定

公式GitHubの公開プレリリースを確認し、バージョン番号が最大の `0.162.0-alpha.20` を別フォルダーへ展開した。alpha.18.1の公開時刻は後だが、版番号が低いため採用していない。npmのグローバル版やCodex同梱版は上書きしない。

- [公式リリース](https://github.com/openai/codex/releases/tag/rust-v0.162.0-alpha.20)
- 資材: `codex-package-x86_64-pc-windows-msvc.tar.gz`
- SHA256: `54c20799c80d402be8a298c2e03b096773c7a9fc4ee98b52f7a92813581af0c4`（公式配布値と照合）
- 保存先: `D:/AIwork/XHarness-runtimes/codex/0.162.0-alpha.20/`
- アプリのCodexフォルダー欄に `D:/AIwork/XHarness-runtimes/codex/0.162.0-alpha.20/bin` を指定し保存。表示されたexeと再起動後の維持を確認。`--version` は `codex-cli 0.162.0-alpha.20`。
- helperとrgを含む公式パッケージ全体を保持する。固定指定中は自動更新されない。戻す場合はパネルの「同梱版の自動追従に戻す」を使う。通常利用プロファイルの設定は変更していない。

以前の失敗はcommandExecutionの`unifiedExecStartup`、終了コード-1、所要0msの準備段階だった。公式[PR #51822](https://github.com/openai/codex/pull/51822)は、ファイルACL取得のMAXIMUM_ALLOWEDを必要なREAD_CONTROL/WRITE_DACへ変更している。調査時のnode_repl.exeとの共有違反の原因に対応する修正で、alpha.20にはこの変更が含まれる。今回は同じようにCodexを起動した状態でcommandExecutionが205ms・終了0となった。すべてのWindows環境で競合が起きない保証とはしない。

## 配布で発見した問題と修正

最初の配布は管理SDK初期化時に停止し、モデル通信は0回。electron-builderのapp.asarにはSDKのpeer依存 `@anthropic-ai/sdk` や検証用の型宣言が不足し、実体コピー後のimportでMODULE_NOT_FOUNDとなった。

`scripts/prepare-sdk-runtime.mjs`をbeforePackで実行し、既存のseed/validate処理で依存関係をまとめて通常resourceに同梱するよう修正。mainは配布時にこのseedを参照する。型宣言とpeer依存の存在・解決先・再作成を検査する回帰テストを追加。途中のv2ではextraResourcesのルート指定がnode_modules除外規則にかかり、v3でfrom/toをnode_modulesまで明示して修正した。

v3の実アプリで同梱0.3.290から管理フォルダーを初期化し、公式registryから互換範囲内の0.3.293へ更新した。今回の全Claude要求の診断はSDK **0.3.293**、同梱CLI **2.1.293**。registry確認/取得はモデル通信回数に含めない。旧SDK・失敗候補を削除していない。

## 実通信結果

phase/query単位で合計**9回**。内部のモデル往復・HTTPリクエスト数とは異なる。各検証20回以内で成功したため再試行を増やさず終了した。

| 検証                                                  | 回数/予算 | 結果                                                                 |
| ----------------------------------------------------- | --------- | -------------------------------------------------------------------- |
| 通常入力の判別、Codex実装、独立テスト、Claudeレビュー | 4/20      | 完了。限定読み取り承認を画面で許可。add.mjsのみ修正、テスト変更なし  |
| Claude実装、独立テスト、Codexレビュー                 | 3/20      | 合成課題パネルから完了。通常入力の判別はこの経路では再実行していない |
| 作業後のCodex質問とHaiku質問                          | 2/20      | 各1回で完了。計画/実装ループに入らない                               |
| 指摘後の修正サイクル                                  | 0/20      | 両レビューとも指摘0件、今回未検証                                    |

使用量は保存された測定値。Codexはthread-cumulative、Claudeはquery-pipelineであり単純合計して一意の消費量とはしない。Inにキャッシュを勝手に加算しない。全9件でusage.complete=trueだが、内部通信回数と金額は欠測。

| 工程                       | 要求モデル              |    In / Out | cache read / create |  時間ms |
| -------------------------- | ----------------------- | ----------: | ------------------: | ------: |
| 通常入力の判別             | gpt-6-luna low          |  13091 / 59 |               0 / — |    5934 |
| Codex経路・計画            | gpt-6-luna low          | 23173 / 246 |           11008 / — |    8640 |
| Codex経路・実装            | gpt-6-luna low          | 47228 / 308 |           22016 / — |   58504 |
| Codex経路・レビュー        | claude-haiku-5-5 low    |  2128 / 825 |         8575 / 9208 |    7089 |
| 作業後の質問               | gpt-6-luna low          |  13387 / 46 |               0 / — |    7475 |
| Claude経路・計画           | gpt-6-luna low          | 11524 / 175 |               0 / — |    8480 |
| Claude経路・実装（Opus分） | claude-opus-5-5 medium  |     8 / 839 |        24080 / 8831 |  14175※ |
| 同じ実装queryのHaiku分     | result.modelUsageの記録 |   1567 / 19 |               0 / 0 | ※に含む |
| Claude経路・レビュー       | gpt-6.1-sol low         |  11399 / 98 |               0 / — |    7942 |
| Haikuへの質問              | claude-haiku-5-5 low    |  2025 / 522 |            0 / 7228 |    4822 |

Haikuレビューは指定/SDK初期/主系列assistant 5件がすべてHaiku 5.5、質問も指定/初期/主系列2件がHaiku 5.5。parent_tool_use_idはnull。Opus実装は指定/初期/主系列6件がOpus 5.5、result.modelUsageにはOpusとHaikuがある。今回主応答をSonnetへ読み替える根拠はない。Haikuの内部用途は観測だけでは特定できない。

保存workflow:

- 判別 `02f3fd71-98d6-4776-9206-7770d5eb4f27`
- Codex実装 `36ea699b-5752-4e88-a8cc-f9e070e9bf83`。base `5dc2a7f48111ca5e20bf4b8d9a819d0d805b82a8` → head `646b7058071ac3b6fc747aac97377336fe4b550d`。独立テスト1件合格、終了0、1530ms。テストSHA256 `C379A60314995AF2C792F45DEA9C6E40B92FEB4866F84EDFEB60A822771763A2` は変更なし。
- 作業後の質問 `919d9d1a-8f3f-4477-9aaa-a6b87fdd6f15`
- Claude実装 `78e9616c-7c7c-443f-9c1b-f47bd0a8c449`。base `cc6f1a21f2e6a6e16e6668c5d99b1a2b5a89184c` → head `940fdcd9598597b5f96a9dfe2c2df4e10af3a0f0`。独立テスト1件合格、終了0、1242ms。
- Haiku質問 `7aa38b70-7fbd-4a1b-afc2-3e8a588cc25c`

Codex実装はworkspace-write/untrustedを維持。request `603968d9-f458-4428-a810-f7c6cc70bb97` の `Get-Content -Raw add.mjs` について実アプリの今回限りの許可を操作し、診断source=explicitを確認。ファイル変更は承認済み計画の範囲。sandboxや承認機能を緩めて成功させていない。

## 配布物と検証

- 実通信した配布物: `.out/codex-alpha20-live-v3-dist/win-unpacked/XHarness.exe`
- 分離home: `.out/codex-alpha20-live-20261008/home`
- exe SHA256: `A1BEC39B365474327D4C440A5D6748E9C5647A000EADEEA843392F7FD1BB6401`
- app.asar SHA256: `AE703A2517AFB439A03DA6416194D4EBDD09F688673CB69E135F6BE4E3A88D64`
- ソース一覧: `.out/codex-alpha20-live-20261008/source-final-sha256.txt`、SHA256 `6291B9029F1BA2D341CB6D535ACFEA35AADC18FDFCC6C5FC731ADDAF690B9CBA`。tracked diffは同じ場所のsource-final.patch、untrackedのsrc/scriptsも一覧で照合する。
- seed外部resourceの全ファイル一覧: 同じ場所の`seed-sha256.txt`、一覧SHA256 `7D58C588EF5F711C7E7274BC9C00488A9ED5C27BCCEE5307CAC7893F575C22D7`。exe/asarが同じでも外部resourceが異なるv2を今回の成功配布物として扱わない。
- 関連7ファイル153テスト＋配布seed回帰1テストの計154件成功。型チェック、対象lint、通常build、headless build、v3 packageは終了0。ログは同じ作業記録フォルダー。
- 全回帰、開発/配布GUI自動テスト一式、portable/recovery、既存インストールの更新は今回未実施。実アプリの上記導線を手動操作で確認。

## 素材と未解決事項

`screenshots/`へ計画、今回限りの操作承認、runtime設定、Codex完了、Claude完了、両社の会話の計7枚と、受け渡し拒否の診断1枚を保存。アプリのウィンドウだけを取得し、ゲームやWindows認証透かしは写っていない。内容の描き替えなし。

通常workflow完了後に同じprojectの新規会話への「結果の受け渡し」を試すと「確定済みの完了タスクと、保存未確定でない宛先が必要です。」で拒否された。handoffs.tsが要求する旧経路のevaluationTask/traceと通常workflowの保存形が接続されていない。履歴を加工して通すことはせず、未解決として残す。これを現在の通常利用の成功例にしない。

紹介PPTX/HTMLの1〜3枚を今回の実通信画像へ更新。4〜7枚は旧経路の既存デモを明示して保持し、受け渡しは通常workflowで利用不可と明記。枠待ち自動再開・子エージェント記録の実通信素材は取得していない。PowerPointのネイティブ描画は未確認。Codexアプリ更新後の自動追従と固定解除、翌日のSDK更新再確認、異常終了復旧も今回未実施。
