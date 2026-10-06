# 限定操作承認とClaudeモデル観測（2026-10-06）

開始HEADは25cad4356b97ab5f319eab89e0b289e8f7fc1150、feature/official-workflow-single-task。開始時clean、CIMで対象checkoutを使う実行プロセスなし。他のローカル作業との競合も確認されなかった。既存変更・配布物は保護し、push/merge/インストール更新は行わない。

## 実装と制限

SPEC §15に基づき、Codexの単純なGet-Contentを計画済みファイル1件に限定して利用者へ確認する。登録テストは従来の範囲を維持するが、複合式は完全一致でも拒否する。network/追加権限/永続policy/範囲外/秘密パス/リンク/不明構文は確認へ回さない。任意shell、Set-Content、shell wrapperは未対応で停止する。ファイル変更は既存の計画scope内のnative経路を使う。

承認は一時的なnonce、workflow/request/session/turn/item、内容digestに紐付ける。表示の後も内容とscopeを再照合し、取消・60秒期限・再起動・遅延回答・重複要求で再利用しない。UIの二重クリックも同期ガードで防ぐ。拒否後にモデルが再試行する前にphaseを停止する。

## Claudeの調査

- インストール済み公式Agent SDKは0.3.290。同梱manifestのCLIは2.1.290。今回のinitでも2.1.290を観測した。
- [公式モデル設定](https://code.claude.com/docs/en/model-config)はhaiku aliasと完全モデルID、起動時指定が環境・通常設定より優先すること、availability fallbackとcontent fallbackの違いを説明する。HaikuからSonnetへ変わった過去記録を、この説明だけで特定のfallbackと断定しない。
- adapterはmodelを明示、settingSourcesは空配列、model/API環境変数を引き継がず、fallbackModelを設定していない。公式SDK型にmanaged設定の別優先層があるため、通常設定を無効にしただけであらゆる設定の影響が消えるとは言わない。秘密を含む設定ファイルをダンプしていない。
- 公式SDKのPostModelSwitchとmodel_refusal_fallbackを許可リストで記録する。指定・初期化・主assistant・補助assistant・modelUsageを分けて表示し、不一致を警告する。通知なしは変更なしの証明ではない。

## 今回の実通信（ソースadapter、配布版ではない）

目的は過去のHaiku alias指定を完全モデルIDに置き換え、同じreadonly/plan・StructuredOutputの短い合成質問で観測すること。最大1query、60秒、失敗や不一致でも繰り返さない。新しい認可・資格情報抽出・追加課金へ切替しない。SDK自身がfirst-party/subscription/included usageを確認してから送信する。

未コミット診断ソース（base 25cad43）、Node24.16.0で1query。指定/解決済みID/init/主系列assistant2件/result modelUsageはすべてclaude-haiku-4-5-20251001。結果completed、4043ms、In5675/Out140、cache read0/create5665（In内数）、reasoning83（Out内数）。入力・出力欠測なし、SDK内部HTTP往復数は欠測。CLI2.1.290、モデル変更通知なし。

以前のalias指定では主assistantがSonnetだったが、今回は完全IDで一致した。時間・サーバー状態も異なるため、aliasが原因と確定できない。製品のモデル指定方式は推測で変更していない。診断helperの集計引数誤り(TypeError)は保存済みusageをオフライン再集計して修正し、再通信していない。証拠は.out/limited-claude-model.json。

この1回のSDK診断はNode24.16.0、Job supervisorのpwshはCodex同梱7.6.5（C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe）。モデル照合はできたが、Store版pwsh7.6.6を使った実SDK通信と同一条件の確認には数えない。Store版での全回帰・GUIは下記の別検証であり、この実通信をやり直していない。

## 検証と未完了

限定承認manager/安全判定/Codex adapter/service/UIの関連試験は成功。実利用者の確認ではなく模擬試験である。承認・拒否・取消・期限切れ・再起動・遅延回答・重複要求・二重クリック・変更された内容・作業範囲外・リンク・引用符の連結を確認した。

最終全回帰は213ファイル/1880件成功（465.88秒）。最初の1873件成功は途中差分の結果であり、最終値と分ける。最後の引用符判定の変更後に追加したテストも最終全回帰で成功している。

typecheck/lint/format:check/build/build:headless成功。scripts/pnpm.ps1を使用し、これらのローカルNodeは22.23.3。WindowsのテストPATHはユーザーのWindowsAppsを先頭にし、Store版pwsh7.6.6を使用（C:/Program Files/WindowsApps/Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe/pwsh.exe）。全回帰とGUIはオフライン・隔離fake home。最終開発GUI25件成功、portable/recoveryの2件は配布物指定なしのためスキップ。開発専用テストを配布成功に数えない。

証拠ログは.out/limited-approval-all-tests-final.log、limited-approval-dev-gui-final.log、limited-approval-typecheck.log、limited-approval-lint.log、limited-approval-format.log、limited-approval-build-final.log、limited-approval-headless.log。変更ファイルのSHA256は.out/limited-approval-source-manifest.json、tracked差分は.out/limited-approval-tracked.patch（新規ファイルはmanifestとcheckoutに保持）。起動した隔離GUIは通常終了済み、無関係なアプリやプロセスを終了していない。

Git作者は未設定だったため確認待ちで停止した。その後、人間から今回だけCodex <codex@local>の指定が承認された。グローバル設定を変更せず、各commitのコマンドだけに指定した。3eabfe7（承認管理170行）、318724e（Codexの限定承認294行）、6b0243a（モデル証跡221行）、9df5873（UIの操作導線241行）に目的を分けてローカル保存した。コミット前にcached差分を確認した。

コードソース9df5873の内容は、前節の最終全回帰・型チェック・両ビルド・開発GUIで検証した差分と同じ。新配布物はこの後に確定する仕様/報告コミットから作成する。Codex実通信での利用者操作承認と独立テスト→Claudeレビューはまだ未実施。模擬承認を実利用者の承認成功に数えない。

## 確定ソースと配布版検証

配布・実通信のソースは98496fbf6ed8fae8c2df139c2122a7036254f978（上記4件のコードcommit＋仕様/報告）。その後の変更は本報告への追記だけ。通常buildをこのHEADから再実行、win-unpackedとportableを作成した。旧配布物は.out/pre-98496fb-packageへ保護し、既存外部配布フォルダーを上書きしていない。

配布GUIは24件成功、portable未指定による1件スキップ。その後にportableを指定してportable.spec.ts/release-recovery.spec.tsを別実行し、2件成功（25.8秒）。開発専用connectionsテストは配布suiteに混ぜていない。すべて隔離fake home、実モデル・認証通信なし。証拠は.out/limited-98496fb-packaged-gui.log、limited-98496fb-distribution.log。通常build/package-dir/package-portable成功、署名ログとpackage author未設定の警告あり。OS権限拒否は今回の実行では発生していない。補助スクリプト追加後のlintも成功した。

配布先は ../XHarness-release/XHarness-98496fb-limited-approval-validation/。portableおよびwin-unpackedの86ファイルをコピーし、全ファイルのSHA256を元distと照合。source-98496fb.jsonとSHA256SUMS.txtにソース/個別ハッシュを保存した。profile・認証・履歴は配布物にコピーしていない。

| ファイル                        | SHA256                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| XHarness-0.0.0-portable.exe     | eb7b7cd38e72b17504183e9714c5ce6a7e3377c0d2b9484f5e0d59597a7b1bf4 |
| win-unpacked/XHarness.exe       | 16ba66ab0bcc18dc55f6252a856d3ba5c40bb8e1307a3b35d42fba22da97323c |
| win-unpacked/resources/app.asar | a24749157e21fadb2a65962d7a57d3c1b52e60ce39aa0e49046d7bded4682603 |

exeとapp.asarは実通信前の保存ハッシュと一致。配布物の再生成・再署名があった場合に、この通信結果を異なるハッシュへ流用しない。

## 配布版での実通信：計画承認後に安全停止

--official-only、隔離home xh-limited-packaged-live-ZfEOja、固定add.mjs/acceptance.test.mjsだけの小さいrepositoryを使用。Node24.16.0、PATH先頭はWindowsAppsのStore版pwsh7.6.6。正規認証はSDK/App Server自身が利用し、資格情報を抽出/コピーせず、有料APIや追加creditへ切替していない。最大7phase query・合計300秒・各120秒、失敗後の再通信なし。実際は2phaseで終了した。

1. Opus計画：指定alias default、解決済み/init/主assistant4件はclaude-opus-5-5。Agent SDK0.3.290/CLI2.1.290。11,389ms、In18,171/Out882（cache read8,058/create8,561はIn内数）。modelUsageにはHaiku In1,548/Out14、Opus In16,623/Out868。Haikuの役割はusage集合だけから推測しない。主assistantはすべてparent=nullのOpus。計画は完成した。
2. 人間がこのチャットで表示中の計画digest ecd020243ad062dcc962ae0bc0aee8256663c11fa2dc486df44e63efdb9fc0bdを承認。現在のworkflow ID/digestを再照合して、実配布版UIの「この計画を承認」をクリックした。自動・無条件承認ではない。
3. Codex実装：公式App Server、gpt-6-luna/low、workspace-write/untrusted。6,286ms。通常枠readはallowed=true、primary使用79%。最初のcommandExecution/requestApprovalが安全判定で拒否され、phaseを停止。操作承認UIは出ていない。In/Outはusage=nullのため欠測、0とは扱わない。具体的な拒否コマンドはraw要求を保存しない現行診断では特定できず、wrapperが原因とも断定できない。
4. add.mjsはa-bのまま、HEAD/baseは同一。チェック・commit・レビューは0件。独立テスト→Claudeレビューは未実施。承認UIの実利用者による個別許可の成功は未確認。計画承認の成功と、操作承認の成功を区別する。

workflow 8fa8a460-8e0e-4db5-966f-10a3c6a80363、request IDs e2a9fc7e-8ac8-45c6-9ce7-9cafbf6b9411（計画）/2dc71a51-d4fe-4620-b0c3-80a4600e642f（実装）。証拠は.out/limited-packaged-live.jsonと隔離homeの保存record/report。画面状態と保存recordはfailed、通常終了して保護した。通常枠確認のmetadata read数/SDK内部HTTP往復数は欠測。今回全体のモデルqueryは、ソースHaiku1回＋配布Opus計画1回＋Codex実装1回＝3回。合計既知In23,846/Out1,022にCodexの欠測を加えるため、完全な総量は不明。

## 残課題

限定操作承認の模擬経路は検証済みだが、実Codexの最初の操作を確認へ渡せず、実装→独立テスト→Claudeレビューは完了していない。許可範囲を自動で広げず停止した。次は、秘密や本文を保存しない拒否理由の分類と合成課題の安全なコマンド情報を追加して、確認へ渡せなかった原因を特定する必要がある。SPEC §15のGet-Content限定を超えてwrapper等を許可する場合は、AGENTSの規定どおり理由と影響を示して実装前に人間へ確認する。

Claudeの過去のHaiku→Sonnet主応答の原因も未確定。完全IDを用いた今回の1回は一致したが、alias原因を証明していない。モデル不一致を警告し、主/補助/使用量を別表示する診断改善は実装済み。push/merge/既存アプリへの上書きインストールは行っていない。
