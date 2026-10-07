# 公式workflow未解決事項の再調査（2026-10-06）

- 開始HEAD: 7b9101c463ade1e0329442c88c72311904b588a4、branch: feature/official-workflow-single-task。開始時clean。同checkoutを使う実行プロセスはCIMで見つからず、他のローカル作業も確認されなかった。
- 過去の配布ソース6bd74a0と今回の結果は区別する。push・merge・インストール更新・資格情報編集は行わない。
- 診断はSPEC §15に従う。request ID、指定モデル、phase、cwd、sandbox、承認設定、ツール名/状態、終了理由を保持する。Claudeのinit、assistantとparent、result modelUsageは別の証拠として保持する。思考本文/rawイベント/ツール本文/認証応答は保存しない。
- 最終返答は明示的な合成診断だけ最大8000文字、秘密値マスク付きで保持する。一般AgentRequestでは無効。固定合成課題サービスのみ有効にする。
- 既存Codexのno-changesは通常返答をruntime保存時に捨てるため原因を判別できなかった。診断はoutputとは別に保存し、no-changesでも保持する。変更なしを成功にしない。
- 診断単体と公式adapterテスト: 41件成功。型チェック・lint成功（開発中の差分、最終検証とは別）。
- 実通信はCodex実装1回（120秒）、Haiku会話1回（60秒）を先に確認する。実装不具合の根拠が得られた場合だけ最小修正後に1回再確認し、変更がある場合に独立テストとClaudeレビュー1回（120秒）を追加する。最大4 query/turn。metadata取得は別計数。失敗の無制限再試行はしない。
- GUIは評価開始のnew_session返答と独立したstateイベントにより、旧promptが有効な間に比較画面を再表示でき、後着の会話切替でDOMが閉じられる。評価画面を新規作成前に閉じ、試験は新しい会話ID・回答・idleを待って再表示する。

実通信・最終回帰・GUI・配布物の結果は後続の検証時に追記する。過去の成功を今回の成功として扱わない。

## 最初の実通信と最小修正

ソースe458cae、Node 24.16.0。公式App Server/Codex Luna lowの実装1 turnはcompletedだが変更なし。通常返答は「exec returned code-mode host is disabled、add.mjsを読めず編集できない」。In 21088 / Out 141、ツール実行証跡なし。原因はX側がnativeツールの実行ホストを起動設定とphase設定の両方で無効化していたこと。OS権限不足を示す証拠ではない。

SDK Haiku指定の会話1 queryは成功。SDK initはclaude-haiku-4-5-20251001、assistant 3イベントはclaude-sonnet-5-5でparent_tool_use_id:null。result modelUsageはHaiku In917/Out15、Sonnet In2/Out124（cache read2050/create2355）。query全体In5324/Out139。主系列assistantにもSonnetが現れ、モデル集合だけから補助処理と断定できない。Haiku分の内部用途とモデル変更の理由は未確認。思考本文は保存していない。

実装/fixのcode_modeとhostを有効にし、code_mode_onlyを無効にする最小修正。公式実行ファイルと同じフォルダーにhost exeが存在する。workspace-write、untrusted、networkAccess:false、スコープ照合、外部機能無効は維持する。読み取りphaseには既存ツール無効設定を維持する。Codex adapter回帰30件成功。

初回証拠は.out/diagnostic-live-e458cae.json。これはソースadapterでの実通信で、配布GUI実通信ではない。以前の配布物の実通信結果を新版へ転記しない。再確認はCodex実装1回のみ追加し、変更がある場合だけ独立テスト→Claudeレビュー1回を行う。Haiku会話は再送しない。

## 修正後の再確認（7c6e593）

Codex Luna low実装1 turn、10413ms、In22663/Out142、cache read11008（In内数）、cache write欠測。nativeはcompletedだがファイル変更なし。診断にcommandExecution requested、承認denied、commandExecution終了が記録された。返答は「required command was rejected by the execution approval gate」。現在のX側はcwd一致かつ登録済みテストコマンドと完全一致したcommandだけ許可するため、読み取り・編集の準備コマンドは許可されない。承認拒否の存在は実イベントで確認済み、個々のコマンド本文は保存していない。

これはツール実行ホストの不具合を直した後に残る承認ポリシーの制限。権限を勝手に解除せず、追加通信を停止した。実装成功、独立テスト、Claudeレビュー成功とは扱わない。将来はworkspace内の限定的な読み取りと承認済みファイルの編集を、具体的なコマンド/変更内容の確認に結び付ける設計が必要。任意shellの一括許可やsandbox緩和は提案しない。

| ソース  | 実通信           | 指定/観測                            | 時間ms |    In | Out | 結果                                 |
| ------- | ---------------- | ------------------------------------ | -----: | ----: | --: | ------------------------------------ |
| e458cae | Codex実装1       | gpt-6-luna / gpt-6-luna              |  30960 | 21088 | 141 | native completed、host無効、変更なし |
| e458cae | Claude会話1      | haiku / init Haiku、assistant Sonnet |   4848 |  5324 | 139 | 回答「2たす3の答えは5です。」        |
| 7c6e593 | Codex実装再確認1 | gpt-6-luna / gpt-6-luna              |  10413 | 22663 | 142 | native completed、承認拒否、変更なし |

合計3 query/turn、取得済みIn49075/Out422（3/3）。cache/reasoningを重複加算しない。SDK/App Server内部のHTTP回数は欠測。Claudeモデル別使用量はquery pipeline全体であり、役割別に分解された計数ではない。Haiku分の用途を補助処理と断定せず、Sonnetの主系列イベントという観測を保つ。

正式SDK0.3.290、Codex App Server0.160.1を使用。既存の公式認証をnative自身で扱い、Xから資格情報ファイルを読んだりコピーしたりしていない。ChatGPT認証・Plus/Pro系plan・公式openai接続・通常枠許可・標準速度を既存gateで確認した。APIキーや追加creditsへの切替なし。

### 環境と検証区分

Windows 11 10.0.26200。実通信diagnostic helperはNode24.16.0、通常検証はscripts/pnpm.ps1のローカルNode22.23.3/pnpm。PATHの先頭を各コマンドだけWindowsAppsにし、pwsh7.6.6（C:/Program Files/WindowsApps/Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe/pwsh.exe）を使用。永続PATH/OS権限/資格情報は変更していない。

実通信はソースadapterで実施した。最終配布物の実通信は行わず、配布GUIは隔離fake homeで模擬検証する。過去6bd74a0配布物の実通信を今回の配布物の成功と扱わない。native DAGの実通信は0回。

## 最終コードの検証・配布物

コードコミット: 084d054（診断）、e458cae（GUI切替同期）、7c6e593f55160c00f0ec72dc8b2de97e4a923fd8（nativeホスト設定修正）。各コミット400変更行以内・1目的。実通信の後に追加のモデル送信は行わない。

- 関連検証: 公式adapter/診断41件、runtime22件、遅延返信GUI単体1件成功。ホスト修正後のCodex回帰30件成功（件数は重複を含むため合計しない）。
- 最終コード7c6e593: typecheck、lint、format:check、通常build、headless build成功。
- 開発GUI: 25成功/2スキップ（portable/recoveryの配布専用環境変数なし）。比較画面は単独実行と全体実行で成功、timeoutは延長していない。
- 配布GUI: 24成功/1スキップ（portable変数なし）。開発限定connection/SIWCテストはdevelopment projectで検証し、配布側から除外する既存区分を維持。
- portable/recovery専用: 2成功、29.3秒。隔離fake homeのみ、通常再起動/所有アプリの異常終了復旧を検証。無関係なプロセスは終了していない。
- 開発中の全回帰: 208ファイル/1849テスト成功、495.82秒。ただし途中にホスト修正が入ったため、最終コードで開始し直した実行と区別する。最終全回帰の結果は後述。
- build scripts、package.json、hook設定を確認し、安全な通常検証のみ使用。実spikeやログイン/認証更新テストは実行していない。実通信は前述3回のみ。

配布保存先: ../XHarness-release/XHarness-7c6e593-diagnostic-validation/。portableとwin-unpackedのみ、新規インストーラーは作成せず、既存アプリへインストールしていない。86配布ファイルの元とコピーのSHA256一致を確認。source-7c6e593.jsonとSHA256SUMS.txtに全ファイルを記録。

| 成果物                          | SHA256                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| XHarness-0.0.0-portable.exe     | 79664596dbe9c4665d4fff0a9a3d55906467a98d54f8211ea78db4e625aa46ea |
| win-unpacked/XHarness.exe       | 460428c1873f8f1a46318651c986f70155584d862e82acaff61914d389f60fa0 |
| win-unpacked/resources/app.asar | 81178533db217428dd6a62596fc2e4176e9f7cb1e6dbb37b535e693352ba61dd |

ビルドの非致命警告はpackage.jsonのauthor未設定、重複依存参照、対象外OS/CPUの任意SDKバイナリ未同梱。今回のビルドにアクセス拒否はなし。配布物の実通信は未実施。

### 残課題

1. Codex実装の準備コマンドを現在の承認gateが拒否する。必要操作ごとの確認・限定承認設計を人間と決める必要がある。今回の制限は解除していない。Codex実装→独立テスト→Claudeレビューは未完了。
2. Haiku指定に対しSonnetのparent:null assistantが返る。モデル別使用量の存在だけから補助処理と決めつけず、SDK内部の役割/切替理由は未確認とする。
3. 実通信はソースadapterのみ。今回配布物での実通信、指摘→修正サイクル、native DAG、Node24での全回帰は未実施。

最終コード7c6e593で開始した全回帰: **208ファイル/1849テスト成功**。除外はpackage.json既定のspike/.out/**、.tools/**、dist/**。実通信診断helperは通常回帰に含めない。失敗/追加スキップなし。全回帰後の変更はこの検証文書だけで、コードと配布物は7c6e593のまま。

未完了の実装権限・モデル内部挙動・配布実通信を成功と扱わず終了する。push・merge・上書きインストール・新規認可は行っていない。
