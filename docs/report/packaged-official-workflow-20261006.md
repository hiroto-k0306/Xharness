> 過去の記録：移動元 `docs/packaged-official-workflow-20261006.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# 配布版公式workflow検証（2026-10-06）

対象: feature/official-workflow-single-task、開始HEAD cfabfcf34fda1dc859237e20cec6d7cb80fd4495。開始時はclean。Get-CimInstanceによるプロセス確認とCodexのチャット一覧に同checkoutを使用する実行中作業は見つからず、無関係なプロセスは終了していない。

現状の問題: 配布版の公式workflowパネルは存在するが、未設定時に実在しない設定画面へ案内する。開発用接続選択のテストが配布版でも走る。通常会話の公式専用導線がない。一般projectのnative書き込み隔離は未完成で、今回も固定合成課題だけを対象とする。

公式専用profileを追加。起動前にElectron保存先を分け、旧資格情報reader・認証更新・旧送信を接続しない。設定・認証ファイルの抽出やコピーは行わない。実通信・配布検証の結果は後続に追記する。

## 操作と検証の分離

- 通常起動でも「公式workflow」パネルから公式Codex exeの絶対パスを保存できる。設定操作に通信はなく、実行時に認証・通常枠・モデルを確認する。未設定の送信は拒否する。
- 既存の旧経路を一切使わない確認には、空の専用homeを `XHARNESS_HOME` に指定し、配布exeを `--official-only` で起動する。公式認証はSDK/App Serverが既存の正規認証を扱う。新しいOAuthや資格情報コピーは行わない。
- 「質問だけ送信」は1 query / 60秒で終了し、直近5件を文脈に使う。「合成課題の計画を作成」は固定課題に限りOpusで計画、表示内容の承認後に指定providerの実装・独立テスト・反対providerのレビューを行う。最大7 phase / 各120秒 / 修正2回。任意projectの通常開発を全面的に提供するものではない。
- Playwrightは `XHARNESS_TEST_EXECUTABLE` の無い場合development、ある場合packagedのprojectになる。connections/connection-profile/SIWCはdevelopmentで引き続き実行する。packagedでは開発UI非公開と公式設定未設定拒否を独立に検証する。storage-safetyの2個目のアプリも指定した配布exeを使用する。
- 実通信は質問2件、順方向workflow、作業後質問1件、逆方向workflow、既知不具合入り合成課題の順で、失敗時には以後の送信を停止する。質問は各1 query、各workflowは最大7 phase・壁時計8分。指摘がなければ修正サイクルは未検証と記録する。SDK/App Server内部のHTTP回数は観測できず、query/turnのdispatch数と区別する。

## 途中結果

- 89940eb: 公式専用profileと旧送信拒否。関連10件合格。
- 0644739: 公式接続設定と未設定拒否。service 6件合格。
- 5137ccb: 質問専用経路。service/Claude/Codex 46件合格。
- d126afa: GUI対象を分離。型チェック・lint・整形・両ビルド合格。
- d126afaの開発GUI初回は24合格・2配布専用skip・1失敗。模擬DAGで25秒の完了待機が不足し、画面証跡では全ノードintegrated・最終integration verify中だった。全回帰とportable圧縮が同時進行していた。対象テストの総時間を60秒、完了待機を45秒へ変更し、検証自体は維持する。

## 最終コードと環境

実行・配布のソースは **6bd74a071342d5518ec4d740e62ba2ba30d09f6f**（ビルド開始時clean）。その後の報告追記コミットはdocsのみ。push・merge・上書きインストールは行っていない。

Windows 11 (10.0.26200)、Electron 44.5.1、electron-builder 26.15.3、公式Claude Agent SDK 0.3.290、公式Codex CLI/App Server 0.160.1。PowerShellはPATH先頭へStore版をコマンド単位で指定し7.6.6、実体は `C:/Program Files/WindowsApps/Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe/pwsh.exe`。システムNodeは24.16.0だが、規定のscripts/pnpm.ps1が子に引き継ぐNodeは22.23.3で、今回の自動試験も22.23.3。Node 24で同じ全試験を再実行したとは扱わない。

### 配布固有の修正

8924d24のwin-unpackedによる最初の接続確認はモデルdispatch 0で失敗。SDKが解決する実行パスを、配布アプリのmainプロセスで通信なしに調べたところ、`resources/app.asar/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe` だった。対応する物理ファイルは `app.asar.unpacked` に存在した。Windows JobのCreateProcessにはElectronの仮想パスが使えないため、6bd74a0で既存unpacked実体へ解決する処理と拒否テストを追加した。ACL・OS権限・認証設定は変更していない。修正後の配布物では公式SDKのqueryを通過した。

63f8213では、接続確認失敗をproviderとアプリ所有の安全なエラーコード/理由に分けて画面・履歴へ記録する。nativeの生stderr・応答・account ID・資格情報はログに出さない。SDK実行パス/失敗理由と既存provider/serviceを合わせた48件の関連テストが合格。

### 最終コードのオフライン検証

| 検証                                        | 結果                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| 全回帰                                      | 206ファイル、1,846件合格、473.59秒                                      |
| typecheck / lint / format:check             | 合格                                                                    |
| 通常build / build:headless                  | 合格                                                                    |
| 開発GUI一括                                 | 24合格、1失敗、2配布専用skip                                            |
| 開発GUIの失敗1件を単独再確認                | improvements.spec.tsが2.2秒で合格。変更を加えず、リトライ設定も0のまま  |
| 配布GUI一括                                 | 24合格、portable未指定による1skip。開発専用3ファイルは別projectの対象   |
| portable.spec.ts / release-recovery.spec.ts | 2件合格、23.3秒 / 3.0秒、隔離fake home                                  |
| 画面・保存履歴・usage・終了状態の照合       | 実通信後に再起動し、5レコード・8 callsを照合して合格。照合時の追加推論0 |

開発GUIの失敗は30秒timeout。比較選択のselectがDOMから外れ、復帰せず待機した記録がある。同じコミットの配布GUIでは合格し、開発版の単独再確認も合格した。新workflowコードとの因果は特定できておらず、負荷だけが原因とも断定しない。一括実行を「全件合格」とは扱わず、既存改善比較テストの同期の不安定さを残課題にする。

ログは `.out/packaged-official-*-6bd74a0.log`、lint最終は `.out/packaged-official-lint-final.log`。初回d126afaの1,844テスト合格と最終1,846件は別の結果。ビルドのauthor未設定・重複依存・非Windows/x64向けSDK任意依存を同梱しない旨の警告は非致命的。esbuildのAccess is deniedは今回再現しなかった。rgは存在する環境で全回帰を実行し、rgをPATHから除いた全回帰は今回未実施（Node代替検索の既存単体テストは全回帰に含む）。

## 配布版による実通信結果

実通信は **6bd74a0のwin-unpacked/XHarness.exe** をPlaywrightで起動し、通常の公式パネル操作（設定保存・質問送信・計画生成・承認）で実施した。元アプリへ接続せず、空home `C:/Users/ahwri/AppData/Local/Temp/xh-packaged-live-or72c5` と、その配下の各固定Git課題を使用した。FakeProviderではない。CLIの資格情報を抽出/コピーする方式・独自HTTP・新規OAuth・有料API切替・追加creditsの購入/切替は使用していない。各query/turnの送信前に公式認証と通常利用枠を検証した。

| 課題                                         | 到達点・結果                                                                                         | dispatch |          In |       Out |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------: | ----------: | --------: |
| 2たす3の質問                                 | completed、回答5、計画/実装なし                                                                      |        1 |       5,459 |        74 |
| 漢数字にする追加質問                         | completed、文脈を引き継いで「五」、計画/実装なし                                                     |        1 |       5,554 |       101 |
| Opus計画→Claude実装→独立テスト→Codexレビュー | completed、テスト合格・レビュー指摘0                                                                 |        3 |      62,328 |     1,828 |
| 作業後のお礼・終了確認                       | completed、1文の回答、再計画/実装なし                                                                |        1 |       5,806 |       114 |
| Opus計画→Codex実装→Claudeレビュー            | **failed: no-changes**。計画/実装応答まで。ファイル変更なしのためテスト/Claudeレビューへ進まなかった |        2 |      41,716 |     1,174 |
| 合計                                         | 8 query/turn、無制限な再試行なし                                                                     |    **8** | **120,863** | **3,291** |

各呼出の取得済み時間は4,247 / 3,965 / 13,354 / 14,340 / 6,942 / 4,499 / 12,974 / 25,353 ms。メタデータ確認・人間承認待ち・プロセステスト等を含む課題の壁時計時間とは異なる。

- 質問3件: 指定は `haiku`。実際のSDK使用量には `claude-sonnet-5-5` と `claude-haiku-4-5-20251001` の両方がある。Haikuだけの実行と記載しない。なぜSonnetも使われたかは未特定で、SDK内部の選択を推測しない。
- 順方向の計画と実装: 指定 `opus`、観測 `claude-opus-5-5` とSDK内部の `claude-haiku-4-5-20251001`。Opusが実装担当に選ばれた計画を確認して承認した。レビューは `gpt-6-luna / low`。
- 逆方向: 計画 `opus`（上記2モデル観測）、実装 `gpt-6-luna / low`。保存証跡にはCodexのツール実行記録がなく、変更なしで安全に停止した。変更しなかった理由は確定できていない。OSアクセス拒否と断定せず、承認やsandboxを緩める対処もしていない。再試行せず、逆方向完走は未達とする。
- 順方向の固定課題は最初から `add(a,b) => a-b` という既知不具合を含む。実装で修正され、レビュー指摘が0件だったため、**指摘→修正→再テスト→再レビューの実通信サイクルは未検証**。同一課題を繰り返して指摘を出させる追加通信は行わなかった。模擬GUIでの修正サイクル成功とは区別する。
- In/Outは8/8呼出で取得。Claudeはquery-pipeline、Codexはthread-cumulativeの公式usageから正規化し、入力に含まれるcacheを二重加算していない。Codexのcache writeは欠測。SDK/App Server内部のHTTP回数は未計測で、8回はXがdispatchしたquery/turnの数。金額・サブスク残量へ換算しない。

証跡は `.out/packaged-live-6bd74a0-*.json` / `*.log` と隔離home内のworkflow.json・report.html。再起動後の画面照合は `.out/packaged-live-6bd74a0-ui-check.json`、画面は `.out/packaged-live-6bd74a0-final-ui.png`。初回8924d24の失敗記録 `.out/packaged-live-questions.json` / `.out/packaged-live-state.json` は別に保持した。

## 配布物とソースの対応

保存先: `C:/Users/ahwri/Documents/Codex/2026-10-05/task/XHarness-release/XHarness-6bd74a0-official-workflow-validation/`。

同コミットから通常build→electron-builder --win --dirを実行。実通信したwin-unpackedを `--prepackaged dist/win-unpacked --win portable --publish never` でportableへまとめた。portableの実通信は未実施だが、模擬分離テストで展開されたapp.asarとwin-unpackedの一致を確認した。コピー後は全86ファイルを元distのハッシュと照合した。旧72dca7eの配布フォルダーは変更していない。

| ファイル                                   | SHA256                                                           |
| ------------------------------------------ | ---------------------------------------------------------------- |
| XHarness-0.0.0-portable.exe                | 643e48df3e1c83044a6b8e9d748030ec20db717bf4ba6609bede1cefeb4ee7a2 |
| win-unpacked/XHarness.exe（実通信したexe） | 39536c235e52c67847dce058fbc2ddcb6afbcffa4be85c867d6c6d227839a1dc |
| win-unpacked/resources/app.asar            | 66551c4c374a8334cb55aba1e19df1a569619559a6291623b0d068038e82b5ae |

`source-6bd74a0.json` と `SHA256SUMS.txt` を配布フォルダーに保存。インストーラーは作成せず、既存アプリを更新していない。

## 判定と残課題

公式SDK経由の質問・追加質問・作業後会話と、Opus計画/Claude実装/Codexレビューの片方向は配布版で利用を確認した。ただし**両方向の新workflowを通常利用可能と宣言できる状態ではない**。

残る項目は、Codex実装が変更を作らなかった理由の切り分けと逆方向の完走、実レビュー指摘後の修正サイクル、Haiku指定時のSDK観測モデル差、開発GUI改善比較テストの不安定さ。任意projectの書き込み隔離とnative DAGは従来どおり未対応/無効。一般projectの通常開発へ拡張したという意味での成功にはしない。今後の実通信を今回の8回の記録へ混ぜず、別の対象コミット・上限・結果として管理する。
