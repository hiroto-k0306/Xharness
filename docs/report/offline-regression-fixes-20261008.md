> 過去の記録：移動元 `docs/offline-regression-fixes-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# オフライン回帰の原因修正と旧GUIケースの退避（2026-10-08）

## 対象・条件

- 開始HEAD: `bc9dc692a98d3d0b5584cdf13ea22193b043c2cd`。main `3520851c44a7ac75ed1d1fbd8d1d606737946e4c` の失敗記録に続く修正。開始時clean。
- 作業ブランチ: `fix/offline-regression-current-workflow`。
- 製品・テストの確定リビジョンと配布ソース: `15d2b109cc6ce562e40a42a32bdaa0a81f04bc44`。その後の記録コミットは本報告のみ。
- Windows 10.0.26300。PowerShell 7.6.5（Codex同梱の `C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。WindowsApps/Store版は未実施。
- ローカル `scripts/pnpm.ps1` を使用。全Vitest回帰は `C:/Program Files/nodejs/node.exe`（24.16.0）を同wrapper経由で明示。互換確認・型・lint・整形・build・GUI・packageはローカルshimのNode 22.23.3。
- AGENTS.md、SPEC.md、package.json、Vitest/Playwright設定、起動fixture、配布フックを確認。FakeProvider・模擬SDK/App Server・fixture・一時Gitリポジトリ・隔離homeを使用。
- 実AI通信、ログイン、実認証更新は0回。追加課金、OS権限変更、既存設定/履歴への変更、上書きインストール、push/mergeは行っていない。

## 原因と修正

1. Windows独立テストがexit 125になった原因は、`owned-process.ts` がPATHの拡張子なしpnpmシムをCreateProcessWへ渡していたこと。Windowsの実行候補を `.exe` に限定し、相対パス指定と非絶対PATH要素も拒否する。Jobへ登録してから再開する順序・取消・所有者喪失・親の自然終了時の子孫停止は維持。拡張子なし/`.cmd`シムを実行しない試験と、`node`/`node.exe`の両方で実exeへ到達する試験を追加した。
2. builder-configの失敗はextraResourcesの先頭2件をfixtureと仮定した試験側の問題。配置名でfixtureを選び、SDK seedは別項目として同梱を確認する。fixtureの存在・秘密ファイルの除外確認は残した。
3. 提供終了モデルの再開試験は存在しない固定CLIパスを指定し、モデル判定より前に実行パス検査で停止していた。実CLIを起動しない模擬発見結果を渡し、提供終了時の拒否まで確認する。
4. 通常fake入力の応答は現在、旧`pong`ではなく公式会話の模擬最終回答。現行の通常質問を3回送り、各1回で有限終了し、計画に入らず、履歴と公開証跡がreload後も一致するGUI試験を追加。ここでのfake会話はSDKを呼ばずharness終了イベントだけを保存するため、実SDKの往復成功とは扱わない。
5. 配布導線試験は自動CLI発見で`available`が変わる環境依存をなくすため、隔離homeに存在しない固定exeの設定を置く。不完全な計画と不正パスを拒否し、旧経路へ戻らず記録/実行を開始しないことを確認する。
6. portableの20秒待機はSDK資源を含む展開時間（前回の計測35,425ms）より短かった。起動待機を60秒、2回の起動を含む試験全体を180秒へ変更。asar照合先は指定したwin-unpackedと対応させる。資源隔離の判定は削らず、復旧試験も現行の模擬回答へ合わせる。

## 退避したケース

利用者の依頼に基づき、旧HTTP/旧fakeループの応答・ツール・権限・画面構成を前提とする14件を `test/archived/gui/` に保存した。元のケースを残し、通常回帰の探索対象外にする。既存のcore/session/toolの単体試験は一切除外していない。

- connections、evaluation、handoffs、improvements、model-candidates、project-history、project-memory、project-skills、quota-resume: 各1件。
- skills-manager: 旧ツールを使う4件。現行の空ダイアログの拒否・取消・入力・Escape・狭い画面の試験は通常回帰に残した。
- smoke: 旧ping/pongと旧LoopFlow切替1件。起動・隔離試験は通常回帰に残した。

`playwright.legacy.config.ts` は明示実行用。`scripts/pnpm.ps1 exec playwright test --config=playwright.legacy.config.ts --list` で **11ファイル・14件** を確認した。元のHEADのケース本文と退避した本文をTypeScript ASTの整形出力で比較し、14件すべて保持されていることも確認した（移動に伴う型importの相対パスとコメント/書式を除く）。旧前提を現行起動へ適応させていないため、退避ケースの成功は保証しない。型・lint・整形の対象には残す。再導入の方法は `test/archived/README.md`。

退避コミットはファイル移動とskills-manager/smokeの分割保存で行数が400行を超えるが、新しい実装をまとめたものではない。製品修正、単体fixture修正、退避、現行GUI修正を別コミットに分けた。

## 検証結果

前回の失敗結果は `docs/offline-regression-20261008.md` に当時の対象リビジョンとともに残す。以下は今回の修正を含む最終コードでの結果。件数の重複は加算しない。

| 検証                                                         | 結果                                                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24.16.0、rgあり、全Vitest回帰                           | **240ファイル・2,196件すべて成功**。終了コード0、543.45秒                                                                                |
| Node 24、owned-process/catalog-roles/builder-config          | **15件成功**。全回帰と重複                                                                                                               |
| Node 22.23.3、同じ3ファイルの互換確認                        | **15件成功**、16.39秒                                                                                                                    |
| Node 24、PATHからrgを外したtools.test.ts                     | **11件成功・1件skip**、3.06秒。rg専用ケースだけ除外、Node代替検索は成功。rgなしの全回帰は未実施                                          |
| typecheck / lint / format:check / 通常build / build:headless | **すべて終了コード0**                                                                                                                    |
| 開発GUI全体（現行対象）                                      | **12件成功・2件skip**、1.3分。skipは配布専用portable/recovery。旧14件は探索対象外                                                        |
| win-unpacked GUI全体からportableのみ別実行へ分離             | **12件成功**、1.1分。未設定拒否・通常入力・公式単一課題・復旧・履歴・隔離を含む。開発専用connection-profile/SIWCは配布プロジェクト対象外 |
| portable GUI                                                 | **1件成功**、1.4分。2つのfake home・展開資源の隔離、asar一致、後続アプリ終了後も先行アプリで会話/保存できることを確認                    |
| 退避ケースの一覧                                             | **11ファイル・14件**。一覧確認のみ、テスト本体は未実行                                                                                   |
| electron-builder portable/win-unpacked                       | **終了コード0**。NSISインストーラーは今回作成していない                                                                                  |

開発・配布GUIは自動retryなし。模擬SIWC OAuth、SDK/App Serverのfixtureでの成功を実認証・実通信成功とは扱わない。

## 配布物と残る確認

配布物は `.out/offline-fix-dist-15d2b10/` に分離生成した。既存の配布物を流用・上書きしていない。ソースは `15d2b109cc6ce562e40a42a32bdaa0a81f04bc44`、要約は同出力先の `source-manifest.json`。

| ファイル/対象                                                               | SHA256                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `XHarness-0.0.0-portable.exe`                                               | `4c575f93ecb267cc551c003a6fbac1a2b6029d003714dd6eb29fed0e2e8f0b10` |
| `win-unpacked/XHarness.exe`                                                 | `6663d8ed466e46b5b5680c01bbedfef46aaee31d7309bb44b993e46e4b46d5df` |
| `win-unpacked/resources/app.asar`                                           | `0eecc212d69ced2916e2249ce95d7f186e6d3bdd5b18c339e502f9d3a86b5a5c` |
| 外部SDK seed（相対パス+ファイルSHA256のJSON、6,522件、英語localeCompare順） | `622ba1d79e16e2703cf9644ef258c8db0dc8bc331a45bf9540c3fec15a46bb34` |

生成時の警告: package.jsonのauthor未設定、pnpm依存重複、非対象OS/arm64のSDK optional binary未同梱。Windows x64の配布生成は成功。未署名の配布物であり、追加の署名設定は行っていない。

ローカルignoredログは `.out/offline-fix-*.log`、開発GUI診断は `.out/gui/`、配布GUIは `.out/gui-packaged-fix-15d2b10/`、portableは `.out/gui-portable-fix-15d2b10/`。

- Store版pwshでのプロセス管理は手元で実施が必要。
- 実SDK/App Serverの通信・認証更新、インストール済みアプリへの適用は今回未実施。
- native DAGを有効にしていない。GUIのDAGケースは既存の模擬課題による確認。
- 退避した旧GUI14件の現行経路への移植は未実施。単体回帰の成功だけで、そのUI導線が検証済みとは扱わない。
