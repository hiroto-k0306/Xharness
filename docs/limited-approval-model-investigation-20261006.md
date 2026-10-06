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
