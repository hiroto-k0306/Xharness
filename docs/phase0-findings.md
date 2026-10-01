# Phase 0 調査結果

手順: [phase0-runbook.md](phase0-runbook.md)
記入者: Codex 実施日: 2026-10-01（日本時間）端末: Windows / D:\AIwork\Xharness
公式 CLI のバージョン: claude 2.1.177 / codex 0.159.2（`--version` で確認）

> 書き方: 実際に通信して確かめたことは「確認」、ソースやドキュメントから読み取っただけのことは「ソース」「推測」と、根拠の欄に必ず書く。トークンなどの値は書かない。

---

## Claude

### 資格情報(C1)

| 項目 | 結果 | 根拠 |
|---|---|---|
| ファイルの場所 | `C:\Users\ahwri\.claude\.credentials.json` | 確認: C1 の読み取りのみ。書き換えなし |
| キーの構造 | `claudeAiOauth` 内に `accessToken`, `refreshToken`: string、`expiresAt`, `refreshTokenExpiresAt`: number、`scopes`: string[]、`subscriptionType`, `rateLimitTier`: string。別に `mcpOAuth`: object | 確認: C1。値は出力・保存していない |
| アクセストークンの有効期間 | `expiresAt` はミリ秒の日時として 2026-10-01 17:08:30.496 JST。検査時点で残り312分。発行時刻を調べていないため、総有効期間は未確認 | 確認: C1。日時への変換結果。API での有効性は未確認 |

### リクエスト(C2・C3)

| 項目 | 結果 | 根拠 |
|---|---|---|
| エンドポイント | `POST https://api.anthropic.com/v1/messages` | 確認: C2、Haiku で HTTP 200 |
| 必須ヘッダ | Bearer 認証、`content-type: application/json`、`anthropic-version: 2023-06-01`、`anthropic-beta: oauth-2025-04-20` の組合せで成功。各ヘッダの省略試験は未実施 | 確認: `test/fixtures/claude/c2-haiku-none.json`。必要最小集合は未確定 |
| system の識別文が必要か | Haiku は system なしで C2 と C3 が成功 | 確認: テキスト応答と get_time 往復。ほかのモデルへの一般化は未確認 |
| 識別文の後ろに自前の system を足せるか | Haiku で識別文 + `Answer in Japanese.` の2ブロックを受理し、`pong` を返した。日本語指示に従うかは未確認 | 確認: `c2-haiku-custom.json`。最初のマスク処理で数値を過剰に伏せており、ヘッダ・使用数の定量検証には使用不可 |
| Haiku 4.5 で成功 | ☑ HTTP 200、`pong`、`end_turn` | 確認: system なし2回（2回目はマスク不具合修正後の再取得）、custom 1回 |
| Opus 5.5 で成功 | ☑ C2 手順2: 識別文のみの system で HTTP 200 / pong / end_turn。元の手順1の再確認は429 | 確認: `c2-opus-identity.json` / `c2-opus-none-recheck.json`。system なしは計3回429。識別文ありの成功後に元の条件を再確認した。識別文の必須性や429の原因は断定しない |
| SSE イベントの順番 | `message_start` → `content_block_start` → `ping` → `content_block_delta`（1〜2回）→ `content_block_stop` → `message_delta` → `message_stop` | 確認: Haiku の実 SSE |
| tool_use / tool_result の往復 | ☑ Haiku、system なし、get_time → tool_result → 最終テキスト、HTTP 200 / 200 | 確認: `test/fixtures/claude/tool-roundtrip.json`。input_json_delta は空の1件を含む4件。引数は `Tokyo`、時刻処理では `Asia/Tokyo` に変換 |
| プロンプトキャッシュが効くか | 未試験（C3 の任意項目） | 必須のツール往復を優先した |

### 使用量(C4)

| 項目 | 結果 | 根拠 |
|---|---|---|
| 5時間枠の使用率が取れるか(ヘッダ名) | `anthropic-ratelimit-unified-5h-utilization: 0.3` | 確認: C2 の HTTP 200 応答。生値を記録 |
| 週間枠の使用率が取れるか(ヘッダ名) | `anthropic-ratelimit-unified-7d-utilization: 0.82`、status は `allowed_warning` | 確認: C2 の HTTP 200 応答。生値を記録 |
| リセット時刻が取れるか | `anthropic-ratelimit-unified-5h-reset: 1790830800`、`anthropic-ratelimit-unified-7d-reset: 1791115200` | 確認: 生値。Unix秒と解釈すると 2026-10-01 14:00 JST / 2026-10-04 21:00 JST。実際に枠がリセットされる時刻との照合は未実施 |

### 期限切れ(C5)

| 項目 | 結果 | 根拠 |
|---|---|---|
| 期限切れ時のステータスとエラー本文 | 未実測。試験時の期限は17:08 JSTで、期限を偽造していない | C5。認証エラーを無条件に期限切れと断定しない |
| `claude -p` 実行で資格情報ファイルが更新されるか | Haiku の CLI 起動は終了0 / pong。access / refresh / expiresAt は変化なし | `cli-refresh.json`。期限前のため、実更新の証明ではない |
| 更新後のトークンで成功するか | 更新が起きず未実測。CLI 起動後の読み直しでは HTTP 200 / pong | `c5-after-cli.json` |
| 採用する対処方法 | v1 は自前 refresh を行わない。期限切れまたは認証エラーで再試行を止め、公式 CLI で更新 / 再ログイン後に読み直して最小リクエストを1回確認 | DESIGN.md §14、ユーザー承認2026-10-01。CLI によるファイル更新だけを AGENTS.md の例外として許可 |

---

## Codex

### ソースで確認したこと(openai/codex)

調査対象: `rust-v0.159.0`、コミット `687a119f0fcaace47e1f1abcc77cec6c813fd6da`。
端末の CLI 0.159.2 と同一バージョンではない。この表は「ソース」。その後の X2 の通信結果は下の表に分けて記録する。
根拠と次の試験条件は [phase0-codex-source.md](phase0-codex-source.md) に記録。

| 項目 | 内容 | ファイル・バージョン |
|---|---|---|
| エンドポイント | ChatGPT 認証の既定 base URL は `https://chatgpt.com/backend-api/codex`。SSE は `POST /responses` | ソース: `model-provider-info/src/lib.rs`、`codex-api/src/endpoint/responses.rs` |
| ヘッダ | Bearer、`ChatGPT-Account-ID`、`originator`（既定 `codex_cli_rs`）、User-Agent、`session-id`、`thread-id`、`x-client-request-id`、`Accept: text/event-stream`。`responses=experimental` は確認した経路に見つからない | ソース: `model-provider/src/bearer_auth_provider.rs`、`login/src/auth/default_client.rs`、`codex-api/src/requests/headers.rs`、`endpoint/responses.rs` |
| ボディの組み立て | 通常経路は `instructions` に base instructions、`input` に履歴、tools、`tool_choice: auto`、reasoning、`store: false`、`stream: true`、`include: [reasoning.encrypted_content]` | ソース: `core/src/client.rs`。これらがサーバー必須という意味ではない |
| トークン更新の方法 | `POST https://auth.openai.com/oauth/token`、JSON の `grant_type: refresh_token`、client_id、refresh_token。戻り値で tokens を更新し `last_refresh` を保存。file モードは auth.json を truncate / write / flush | ソース: `login/src/auth/manager.rs`、`login/src/oauth/client.rs`、`login/src/auth/storage.rs`。更新処理は実行していない |
| 使用量ヘッダの読み取り | `x-codex-primary/secondary-used-percent`、`-window-minutes`、`-reset-at`。limit_id ごとの `x-<limit>-...` にも対応 | ソース: `codex-api/src/rate_limits.rs`。primary が5時間・secondary が週間とはまだ確定していない |
| モデル一覧の取得 | `GET /models?client_version=<version>`、`{ models: [...] }` と ETag を読む | ソース: `codex-api/src/endpoint/models.rs`、`model-provider/src/models_endpoint.rs`、`models-manager/src/manager.rs`。取得可能性は X5 で実証する |

### 資格情報(X1)

| 項目 | 結果 | 根拠 |
|---|---|---|
| キーの構造 | `auth_mode`: string、`OPENAI_API_KEY`: null、`tokens.{id_token, access_token, refresh_token, account_id}`: string、`last_refresh`: string | 確認: X1。`C:\Users\ahwri\.codex\auth.json` の読み取りのみ。値は出力・保存していない |
| id_token の期限・プランのキー名 | `exp`: number → 2026-09-27 21:25:38 JST（検査時点で期限切れ）。`https://api.openai.com/auth` 内の `chatgpt_plan_type`: string | 確認: X1 の JWT ペイロードをデコード。署名未検証。アクセストークンの期限・API での有効性とは別で、そちらは未確認 |
| access_token の期限 | JWT exp は2026-10-07 20:25:38 JST。CLI 試験時点で期限前 | 確認: X7 の読み取りのみ。署名未検証。API での有効性は X2 と CLI 起動後の疎通で確認 |

### リクエスト(X2・X3)

| 項目 | 結果 | 根拠 |
|---|---|---|
| 必須ヘッダ | Bearer、chatgpt-account-id、originator: codex_cli_rs、User-Agent: codex_cli_rs/0.159.2、session-id / thread-id / x-client-request-id、Content-Type: application/json、Accept: text/event-stream で成功。OpenAI-Beta は付けていない | 確認: X2。各ヘッダの省略試験は未実施で、必要最小集合は未確定 |
| `instructions` の制約 | `You are a helpful assistant.` を3モデルで受理 | 確認: X2。既定の CLI 指示文は使っていない |
| `store: false` は必須か | false で成功。true / 省略は未試験のため必須かは未確定 | 確認: X2 |
| GPT-6 Luna で成功 | ☑ HTTP 200、pong、response.completed | 確認: `test/fixtures/codex/x2-gpt-6-luna.json`。Content-Type がなく、初回はスクリプトが解析に失敗。保存済み SSE を再解析し、追加通信はしていない |
| GPT-6.1 Sol で成功 | ☑ HTTP 200、pong、response.completed | 確認: `x2-gpt-6-1-sol.json` |
| GPT-6 Astra で成功 | ☑ HTTP 200、pong、response.completed | 確認: `x2-gpt-6-astra.json` |
| SSE イベントの順番 | response.created → response.in_progress → response.output_item.added → response.content_part.added → response.output_text.delta → response.output_text.done → response.content_part.done → response.output_item.done → response.completed | 確認: X2 の3件。応答に Content-Type がなくても event / data フレームを読み取る必要があった |
| function_call / function_call_output の往復 | ☑ Luna、両方 HTTP 200。get_time が timezone: Asia/Tokyo を要求し、12:34:04 の結果に対して「12:34 PM in Tokyo」と回答 | 確認: `x3-tool-1.json` / `x3-tool-2.json` / `tool-roundtrip.json`。確定 item をそのまま input に追加し、同じ call_id の function_call_output を返送 |
| 2回目に推論の内容をどう渡すか | 保存済み Luna max の reasoning（encrypted_content 含む）と message を変更せず input に返し、次ターンが HTTP 200 / pong / completed | `x3-encrypted-replay.json`。初回は X4 の保存済み応答を再利用して追加通信1回。関数往復の初回には reasoning がなかったため、関数往復と推論返送を別の実通信で確認 |

### effort(X4)

| モデル | 受け付けた値 | 拒否された値 |
|---|---|---|
| gpt-6.1-sol | low / medium / high / xhigh / max | なし（拒否値の探索はしていない） |
| gpt-6-astra | low / high / max | なし（medium / xhigh は X5 掲載のみ） |
| gpt-6-luna | low / high / max | なし（medium / xhigh は X5 掲載のみ） |

X4 は8リクエスト、すべて HTTP 200 / pong / response.completed。high は X2 の結果を再利用した。
fixtures: `x4-gpt-6-1-sol-{low,medium,xhigh,max}.json`、`x4-gpt-6-{astra,luna}-{low,max}.json`。
max の3モデルは reasoning item に encrypted_content を返した。これはテキスト単独応答で、次ターンの返送確認とは別。

Ultra は調査した CLI の `ModelInfo::resolve_reasoning_effort` が通常リクエスト用の値に変換する UI 選択。
Sol / Astra の X5 設定は multi_agent_reasoning_effort: xhigh で、この条件では Ultra は xhigh に解決される。
raw ultra の受理と、Ultra に伴う自動委譲は試していない。ユーザー承認2026-10-01により `ultra: ultra` を削除。Phase 1 は通常 effort の low / medium / high / xhigh / max に限定し、Ultra は委譲を含む設計まで保留する。
Light という UI 名に対応する値は、今回の対象モデル一覧にはなく、推測で追加していない。
根拠: [phase0-codex-source.md](phase0-codex-source.md)。

### モデル一覧・使用量・期限切れ(X5〜X7)

| 項目 | 結果 | 根拠 |
|---|---|---|
| モデル一覧の取得手段 | GET https://chatgpt.com/backend-api/codex/models?client_version=0.159.2、HTTP 200。models 配列10件、ETag あり | 確認: `x5-models.json`。取得は1回、条件付き GET は未試験 |
| 5時間枠・週間枠の使用率(ヘッダ名) | x-codex-primary-used-percent: 19〜21、primary-window-minutes: 300。secondary-used-percent: 7、secondary-window-minutes: 10080。prefix はいずれも x-codex- | 確認: X2 の保存済みヘッダを X6 で抽出。5時間 / 週間は返された window-minutes と照合 |
| リセット時刻 | x-codex-primary-reset-at: 1790840426、secondary-reset-at: 1791384380〜1791384381。reset-after-seconds も取得 | 確認: X2 の生値。実際に枠が戻る時刻との照合は未実施 |
| 期限切れ時のステータスとエラー本文 | 未実測。access_token は期限前で、期限を偽造していない | X7 |
| `codex exec` 実行で auth.json が更新されるか | Luna low の CLI 起動は終了0 / pong。access / refresh / last_refresh は変化なし | `cli-refresh.json`。最初の2回は内蔵 provider の上書き禁止に触れ、推論前の設定エラー。原因をソースで確認し、余分な設定を除去後に成功 |
| CLI 起動後の直接疎通 | 読み直した資格情報で HTTP 200 / pong | `x7-after-cli.json`。更新が起きなかったため「更新後」の成功とは扱わない |
| 採用する対処方法 | Claude と同じく自前 refresh を行わず、認証エラーで止めて公式 CLI に更新を委ね、ファイルを読み直す。更新が失敗する場合は再ログインを案内 | DESIGN.md §14、ユーザー承認2026-10-01。公開ソースの refresh 実装は調査済み |

---

## 横断(R1・R2)

| 項目 | Claude | Codex | 根拠 |
|---|---|---|---|
| 429 のステータス・ヘッダ・本文 | Opus C2 で HTTP 429、`x-should-retry: true`、JSON `error.type: rate_limit_error` / `message: Error`。Retry-After はなかった | 自然な429は未発生。ソースのテストは HTTP 429 と error.type: usage_limit_reached を usage limit エラーに変換する | Claude は実測。Codex は `codex-api/src/api_bridge_tests.rs`（調査コミット）のソースのみ。使用量を使い切って誘発していない |
| ストリーム中断時の例外 | HTTP 200、message_start 後に abort、AbortError。4イベント保存、message_stop なし | HTTP 200、response.created 後に abort、AbortError。1イベント保存、response.completed なし | 確認: 両方の `r2-abort.json`。Node.js 22 の fetch / AbortController。受信済みバッファのイベントは中断指示後にも読み取られる場合がある |

---

## 結論

- [x] 両プロバイダとも OAuth で直接呼べる。手順書の6つの Phase 0 完了条件を満たし、Phase 1 に着手できる（本作業では未着手）

完了判定は「期限切れへの対処方法の確定」を含む。実更新・期限切れエラーの観測完了とは別。未試験事項は上の表に明記し、全ヘッダの必要性を断定していない。Opus の疎通成功は追加の手順2試験で確認。

設計書から変更が必要な点:
- Claude の C2 / C3 / C5 結果と、Codex の X2〜X7 結果を §7 に反映した。
- Codex の `session-id` / `thread-id` と、experimental beta なしの成功を §7.2 に反映した。必須ヘッダの最小集合は未確定。

予算の予約数: Claude 13 / 20、Codex 22 / 25（2026-10-01）。直接試験は Claude 12件・Codex 19件。ほかに Claude CLI 1起動、Codex CLI 3起動（2回は推論前の設定エラー）を予約した。CLI 内部の HTTP 回数は観測しておらず、予約数を実 HTTP 回数とは扱わない。
最初の Haiku 2件と Opus 1件はトークン数を過剰にマスクした。元の数値を推測で復元していない。
修正後の `c2-haiku-none.json` を変換テストと C4 の使用量確認に使用する。

C3 は3リクエスト。初回の get_time 引数 `Tokyo` を Intl が受理せず、結果返送前に停止した。
保存済みの tool_use を再利用して返送したが、短い日付 `01/10/2026` をモデルが1月10日と誤読した。
ISO UTC と `2026-10-01 12:27:16` のローカル日時を含む JSON に修正して、結果返送だけを再試験した。
最終応答は October 1, 2026 / 12:27:16 で、返した時刻・日付と一致した。

X5 の掲載モデル: gpt-6.1-sol、gpt-6-astra、gpt-6-sol、gpt-6-luna、gpt-reserve、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna、gpt-5.5、codex-auto-review。
全10件の context_window は272000。これは返された設定値で、上限まで入力しての検証ではない。
Sol / Astra は low / medium / high / xhigh / max / ultra、Luna は low / medium / high / xhigh / max を advertised supported_reasoning_levels として返した。
Luna の初期カタログの「High〜Maxのみ」と異なる。X4 で low / max も受理することを確認した。Ultra は上記の承認により保留。

CLI 起動後の追加観測: Claude の5h使用率0.35、7d使用率0.82。Codex の5h使用率41%、週間使用率10%。初回 fixtures は保持し、追加応答を c5-after-cli / x7-after-cli に保存した。
