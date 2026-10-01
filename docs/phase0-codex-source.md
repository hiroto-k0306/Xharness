# Phase 0: Codex 公式ソース調査

実施日: 2026-10-01（日本時間）。API リクエストなし。
対象: openai/codex の `rust-v0.159.0`、コミット `687a119f0fcaace47e1f1abcc77cec6c813fd6da`。
端末の `codex-cli 0.159.2` とは異なる。取得した公開ソースは git 管理外の `.tools/codex-source/` に置いた。
以下はソースの動作であり、エンドポイントの現在の受理条件は X2 / X5 で確認する。

## URL とヘッダ

- ChatGPT 認証の既定 base URL は `https://chatgpt.com/backend-api/codex`。[model-provider-info/src/lib.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/model-provider-info/src/lib.rs)
- 通常 SSE 経路は `POST /responses` に `Accept: text/event-stream` を付ける。[codex-api/src/endpoint/responses.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/codex-api/src/endpoint/responses.rs)
- 認証は `Authorization: Bearer <access_token>` と `ChatGPT-Account-ID`。[model-provider/src/bearer_auth_provider.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/model-provider/src/bearer_auth_provider.rs)
- `originator` の既定値は `codex_cli_rs`。User-Agent は originator・ビルドバージョン・OS・端末情報から作る。[login/src/auth/default_client.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/login/src/auth/default_client.rs)
- セッション情報のヘッダは `session-id` / `thread-id`。ResponsesClient は thread_id から `x-client-request-id` も付ける。[codex-api/src/requests/headers.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/codex-api/src/requests/headers.rs)
- 確認した通常 SSE 経路に `OpenAI-Beta: responses=experimental` は見つからなかった。WebSocket ハンドシェイクには別の値 `responses_websockets=2026-02-06` がある。[core/src/client.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/client.rs)

## ボディと推論履歴

通常経路の `build_responses_request` は `instructions` に base instructions、`input` に履歴、tools、`tool_choice: auto`、reasoning、`store: false`、`stream: true`、`include: ["reasoning.encrypted_content"]` を入れる。
parallel_tool_calls、service_tier、prompt_cache_key、text、client_metadata なども状況に応じて組み立てる。
Responses Lite 経路では instructions と tools を input の先頭項目へ移す別処理がある。
根拠: [core/src/client.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/client.rs)、[codex-api/src/common.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/codex-api/src/common.rs)。

自前 instructions の受理条件と推論 item の返送は未検証。CLI が設定する値だけを根拠に、サーバーの必須項目と断定しない。

## 更新処理

`request_chatgpt_token_refresh` は `https://auth.openai.com/oauth/token` に JSON の refresh grant を送る。
項目は `grant_type: refresh_token`、公開 client_id、refresh_token。戻り値に存在する tokens を更新し、`last_refresh` を現在日時にする。
file モードの保存は auth.json を truncate / write / flush する実装で、原子的 rename とは異なる。
アクセストークンの JWT exp が取得できる場合は期限の接近で、取得できない場合は last_refresh からの経過で proactive refresh を判断する。
根拠: [login/src/auth/manager.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/login/src/auth/manager.rs)、[login/src/oauth/client.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/login/src/oauth/client.rs)、[login/src/auth/storage.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/login/src/auth/storage.rs)。

更新の実行、リフレッシュトークンのローテーション、期限切れ API エラーは未確認。
Phase 0 では自前 refresh と資格情報ファイルの書き換えを実装しない。

## 使用量とモデル一覧

`rate_limits.rs` は primary / secondary の `used-percent`、`window-minutes`、`reset-at` を読む。
既定 prefix は `x-codex`、別 limit_id は `x-<limit>`。枠の長さを固定で仮定せず、返された window-minutes と照合する。
根拠: [codex-api/src/rate_limits.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/codex-api/src/rate_limits.rs)。

モデル一覧は `GET /models?client_version=<version>`。`ModelsResponse { models }` と ETag を読み、manager が認証状態・キャッシュ鮮度を踏まえて取得する。
根拠: [codex-api/src/endpoint/models.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/codex-api/src/endpoint/models.rs)、[model-provider/src/models_endpoint.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/model-provider/src/models_endpoint.rs)、[models-manager/src/manager.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/models-manager/src/manager.rs)。

X2 は指定モデル GPT-6 Luna / effort high と短い instructions で試し、X5 は一覧を1回取得して項目の形を記録する。
API の成功前にモデルカタログを verified にしない。

## effort の変換（X4 前に確認）

`ReasoningEffort` は low / medium / high / xhigh / max / ultra 等の名前を持つが、列挙型の名前すべてがそのまま推論 API に渡るわけではない。
`ModelInfo::resolve_reasoning_effort` は Ultra をモデルの multi_agent_reasoning_effort に解決し、未設定・非対応なら Max、最後の非 Ultra 値、Medium の順にフォールバックする。
根拠: [protocol/src/openai_models/reasoning_effort.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/protocol/src/openai_models/reasoning_effort.rs)。
X5 の Sol / Astra では multi_agent_reasoning_effort が xhigh。X4 では raw ultra を試さず、通常リクエストの low / medium / xhigh / max を検証した。
ソースの UI 動作と、実際に受理した wire 値を区別する。Ultra の自動委譲は今回試していない。

参考: [公式認証ドキュメント](https://learn.chatgpt.com/docs/auth)は、ChatGPT 認証・ローカル auth.json / credential store・CLI の自動更新を説明している。上記の通信詳細は公開ソースを根拠にした。
