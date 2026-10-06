# 開発版UIの公式接続選択

2026-10-06、`feature/official-connection-boundaries`。第2段階の `fdb9582` から継続。SPEC.mdが現行仕様。インストール済みアプリの更新・push・mergeは行わない。

開発版（非packaged）の通常画面に「接続方式」を追加した。既存方式 / OpenAI SIWC / Claude Agent・X実行 / Claude Agent・X MCPをセッション単位で明示選択する。下書きのキャンセルでは変更しない。空のセッションでのみ方式を変更でき、履歴を異なる認証経路へ転送しない。選択はsession recordの追加フィールドとして保存し、旧recordは既存方式になる。モデル・effort・既存config・認証設定は選択で変えない。対応するモデルも既存ModelPickerで明示選択する。

状態は「未設定」「利用可能」「認可必要」と具体的理由を表示する。未設定でも選択は保存できるが、送信は履歴追加・通信・fallbackの前に拒否する。Claudeの接続確認は明示ボタンのみ。キャンセル・停止・終了でSDKをcloseし、遅れた結果で利用可能にしない。利用可能状態はメモリ内だけで、再起動では再確認する。fakeではClaude両方式が固定応答で利用可能になり、SIWCは未設定のまま。

設定済みXフック・wave checkは今回未対応なので、設定があれば保護を無視せず通信前に停止する。新接続は通常テキストの既存Agent Loopへ接続し、同じhome writer、権限gate、ファイルcheckpoint、通信予算、receipt、履歴、task trace、評価を使う。SDK内部のツール実行は前段階の永続intent台帳を通す。自動ルーティング・既存方式へのfallback・旧providerによるWeb補助通信・workflow段階は実行しない。画像・slash commandは送信前に拒否する。失敗後のタスク関連付けを維持し、正常終了をsettledとして保存する。

## Claude：機能・認証・配布を分ける

[2026-06-16公式告知](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) の冒頭は、June 15の別クレジット移行が停止され、SDK・claude -p・第三者アプリ利用が従来のサブスク枠を使うと説明する。下段の古いクレジット条件は現行判定に使わない。[公式SDK概要](https://code.claude.com/docs/en/agent-sdk/overview) と [認証・配布条件](https://code.claude.com/docs/en/legal-and-compliance) は第三者製品が利用者のClaudeログインを提供する制限を別に記載している。本人のローカル開発用SDK確認が成功しても、配布向けの承認を取得したとは扱わない。このUIは開発版限定で、packaged版に新選択を公開しない。

SDK 0.3.290の正式 `accountInfo()` と `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({skipBehaviors:true})` を実型で利用する。後者はexperimentalのため版本固定と契約テストが必要。認証は変更していない公式SDK自身が扱う。XはCLI資格情報ファイル・秘密の値を独自に読まず、秘密をrendererやログへ渡さない。環境変数は名前からundefinedで排除し、OSの経路など必要な項目だけ許可する。APIキー・auth token・cloud/proxy経路・NODE_OPTIONSなどを引き継がない。user/project設定・hooks・plugins・skills・MCP自動読込も無効。SDK依存はElectron mainビルドで外部化し、公式パッケージのnative実行物の探索を保持する。

各送信は同じSDKプロセスへのstreaming inputを保留し、firstParty・サブスク・APIキー経路なし・Usage枠取得・Extra Usageのis_enabled=falseを確認後に初めてプロンプトを渡す。API経路、有効なExtra Usage、不明値、初期化失敗では具体的理由を表示し止める。認証・課金設定を自動変更せず、新しいログインやトークン発行を起こさない。これは取得時点の状態確認であり、将来のアカウント設定変更やプロバイダの課金運用まで保証するものではない。

## 今回の許可内ライブ検証

2026-10-06T03:36:09Z開始。Windows / Node 24.16.0 / PowerShell 7.6.5 / SDK 0.3.290。API・認証・接続先切替環境変数8項目の存在のみを調べ、すべて未設定。公式SDK自身がfirstParty・Proサブスク・APIキー経路なし・Extra Usage=falseを返した。新しい認可・設定変更・資格情報の独自読出しは行っていない。

空の作業領域、toolsなし、maxTurns=1、60秒timeoutで `Reply with exactly OK. Do not use any tools.` を **1回のquery/testだけ** 送った。実モデル `claude-haiku-4-5-20251001`、success、OK一致、SDK duration 1036ms。main-loop usageはinput 726/output 50（thinking 43はoutput内）、query-pipeline modelUsageはinput 1629/output 62、cache-read/writeとも0。二つのscopeを加算しない。推定API換算額$0.001939は請求額・サブスク枠消費額ではない。SDK query内部の補助HTTP回数は未観測で、1 HTTPリクエストだったとは主張しない。

この一回はUI完成前の公式SDK直接確認で、最終UI・A構造化出力・B MCPのライブ合格とは同一視しない。最終UIはfakeで検証する。追加ライブは今回は実行しない。生結果の秘密を含まない投影はローカル `.out/sdk-personal-live.json` に保存した。既存の拒否済みcredential probeや独自HTTPを再開していない。今回の公式SDK検証とオフライン実行の自動承認レビューは許可され、承認拒否ブロックはなかった。

## OpenAI：登録前に必要なもの

登録仕様は [正式SIWC登録手順](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)。システムブラウザの認可URLは `https://auth.openai.com/api/accounts/authorize`、code交換URLは `https://auth.openai.com/api/accounts/oauth/token`。

XHarnessという実アプリ名をagent_name_hintに一貫して使う。hostごとに永続ext_agent_host_idを用意し、初回だけclient_id=dynamic_agent_clientを使う。毎回state/nonce/PKCE(S256)を生成し、127.0.0.1のHTTP loopback callbackを先にlistenする。resourceはhttps://api.openai.com/v1、scopeはopenid/profile/email/offline_access/resource.invoke/chatgpt.tokens.use.direct。callbackのscheme・host・pathは固定し、同じ試行ではportも同じにする。

本人がブラウザでChatGPTアカウントを選び、アプリ名・権限を確認して認可する。callbackのstateを照合し、発行されたclient_idでcodeを交換する。JWKS署名・issuer・発行client IDのaudience・nonce・期限・identityと、付与されたplan-use scopeを検証してから、その登録専用の保護された保存先を設ける。dynamic_agent_clientは発行IDの代用ではない。既存Codex CLIの資格情報やclient IDは転用しない。

**具体的不足**：XHarness専用の発行client ID、本人の独立plan-use grant、callback/token検証・保護保存・正式HTTP transportの実装。UIはこれを未設定として示す。今回ブラウザを開いて登録・OAuth・トークン保存はしていない。登録のユーザー操作を要求する前に、そのcallback・保存実装が必要。

## 再実行と検証証跡

`pnpm dev:fake` で新規セッションを作り、接続選択→キャンセル→再選択→SIWC送信拒否→Claude fake応答を確認できる。本人の実接続は `pnpm dev` の空の新規セッションでClaude方式とClaudeモデルを選び、「公式SDK接続を確認」を実行する。確認は推論しないが正規SDKによる認証/usage制御通信を伴う。失敗時の理由に従い本人が公式ログイン・Usage設定を確認する。追加認可が必要ならそこで止め、Xから自動作成しない。

focused: connections全体、session/connections、session/controller、shared/ipc、ConnectionPicker、electron-bundleの117件。SDK実型を使い、Usage不明/Extra Usage有効/API経路の送信防止、確認中止・遅延、選択保存・再起動、元設定保持、未設定拒否、両fake方式の履歴/traceを確認する。fake GUIのconnections/smoke/evaluation、typecheck、lint、format、Electron/headless buildも対象。全回帰は最後のコード・文書をコミットした最終HEADで実行し、`.out/connections-ui-final-full.json` と `.out/connections-ui-final-validation.json` に記録する。過去段階の合格件数は最終HEAD結果として流用しない。

残課題：SIWC正式登録とtransport、Claude第三者向け配布の承認判断、SDK experimental usage API変更への追従、A/B最終UIのライブ動作、画像・workflow・補助モデル呼出しへの新接続拡張。既存インストール更新は別途依頼時に扱う。
