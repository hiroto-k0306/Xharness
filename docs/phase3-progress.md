# Phase 3 実装・確認記録

開始: 2026-10-01 JST。記録更新: 2026-10-02 JST。`origin/main` の `bf1aea9` を取り込み、main から `phase3` を作成した。変更は未コミット。main へのマージ・push は行っていない。

## 1〜2 の区切り

- CodexAdapter: Phase 0 で成功したヘッダ、store:false / stream:true / include / tool_choice:auto を採用。OpenAI-Beta は送らない。
- カタログにある有効モデル・effort のみ送る。Ultra は拒否。資格情報は読み取りのみ、例外・HTTP 本文を外へ出さない。
- 共通 SSE reader は Content-Type に依存せず、CRLF と分割チャンクを処理する。
- 実録の `response.completed.output` は空配列であるため、`response.output_item.done` を output_index 順に集めて確定メッセージを組み立てる。
- function_call / function_call_output の call_id の往復、確定した encrypted reasoning item の無変更返送を fixtures で確認。
- x-codex-primary / secondary の使用量を ProviderEvent 経由で UiEvent usage へ渡す。欠損は取得不可、reset は ISO 8601。5h / weekly は window-minutes と照合する。
- この区切りでは変換・HTTP・SSE の13件と typecheck が成功し、一度報告した。この時点の実通信は0回。その後に以下の検索確認を実施した。

## 3〜7 の実装

- Router を Electron / headless に接続。`/model provider:model [effort]` と既存 set_model でセッションだけを変更し、次の周の STEP 1 から反映する。会話へコマンドは追加しない。
- 履歴は追記のみ。他社の reasoning は送信用コピーから除外し、同社へは opaque payload を変更せず返送する。プロバイダをまたいだ tool ID は hash で安定変換し、結果側と一致させる。
- 429 は60秒以内なら同じモデルで最大3回再試行（初回を含め4送信）。長い・不明・再試行終了なら config の fallback へ切り替えて STEP 1 に戻る。訪問済みモデルに戻らず、両方枯渇しても循環しない。Claude の待ちは unified reset ヘッダから算出する。
- Codex FakeProvider は実録 text / function_call 往復 / encrypted reasoning / 切断を再生する。`read` / `tool` キーワードは実録の get_time 呼び出しを忠実に再生するため、通常の6ツール登録では未知ツールとして返る。往復試験では get_time の stub を明示して確認した。
- WebSearch は両方で利用可能と分かってから実装。親の function 呼び出しとして承認を得た後、同じプロバイダの Haiku / Luna に独立した1検索要求を送る。親の履歴・ワークスペースは渡さない。専用イベントの検索完了を確認し、本文と取得できた引用を注記付き tool_result にする。
- WebFetch は公開 HTTP(S) のみ。localhost / 非公開 IP / DNS 混在 / 別ホストへのリダイレクトを拒否。DNS で検証した IP を dispatcher に固定し、リダイレクトごとに再確認する。期限・受信容量・形式の制限と abort を持ち、HTML はテキストにする。
- `web.enabled`（既定true）、`web.searchMode`（既定live）をグローバル設定へ追加。Claude は live のみ、Codex は live / cached。すべて gate を通り、Phase 3 は全ツール ask を維持。
- `--fake` の WebSearch は録画 SSE、WebFetch は合成ページを返す。DNS / fetch / 資格情報を使用しない。両方の検索録画とモデルカタログをパッケージ設定に追加した。

## Web 検索の指定方法の確認

送信前にローカルの公式 Codex CLI ソースを読んだ。commit `687a119f0fcaace47e1f1abcc77cec6c813fd6da`、ソース版0.159.0。Phase 0 の通信で採用した CLI ヘッダ版は0.159.2であり、同一版とは扱わない。

- [core/src/tools/hosted_spec.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/core/src/tools/hosted_spec.rs): Cached → external_web_access false、Live → true、Disabled → 未登録。Indexed の指定は今回実装しない。
- [tools/src/tool_spec.rs](https://github.com/openai/codex/blob/687a119f0fcaace47e1f1abcc77cec6c813fd6da/codex-rs/tools/src/tool_spec.rs): type web_search と external_web_access のシリアライズを確認。
- `core/tests/suite/web_search.rs` と hosted_spec のテストも確認。cached false / live true の変換を XHarness の単体テストでも確認した。
- Claude は [公式 Web search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) の基本版 `web_search_20250305` を送り、実際の成功を下表に記録した。新しい版は送信していない。

## 検索疎通と使用量の前後差

2026-10-01 JST、各プロバイダで短い pong 要求を1回送り、その直後に公式 Node.js サイトを探す検索を1回送った。自動再送なし。比較は同じ確認の2レスポンスのヘッダによる。

| 項目                             | Codex                                             | Claude                                                 |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------------------ |
| モデル / effort                  | gpt-6-luna / low                                  | claude-haiku-4-5-20251001（effort は送らない）         |
| 受理したツール                   | web_search、external_web_access true              | web_search_20250305、max_uses 1                        |
| baseline / 検索 HTTP             | 200 / 200                                         | 200 / 200                                              |
| 検索完了                         | completed web_search_call 1件、response.completed | server_tool_use / web_search_tool_result 1件、end_turn |
| 5h 使用割合（前→後）             | primary 87% → 87%（差0ポイント）、300分           | 0.0 → 0.0（0% → 0%、差0ポイント）                      |
| weekly 使用割合（前→後）         | secondary 33% → 33%（差0ポイント）、10080分       | 0.84 → 0.84（84% → 84%、差0ポイント）                  |
| 5h reset（Unix秒、前後同じ）     | 1790858556                                        | 1790872200                                             |
| weekly reset（Unix秒、前後同じ） | 1791384380                                        | 1791115200                                             |

割合の丸め・他の利用があるため、差0を無消費の証拠とはしない。Codex は検索完了イベントがあるが annotations は空で、本文に `https://nodejs.org/` が返った。Claude は検索結果の URL / タイトルを取得できた。引用が無いことだけでは検索失敗にしない。

録画: `test/fixtures/{codex,claude}/phase3-web-baseline.json`、`codex/phase3-web-live.json`、`claude/phase3-web-haiku.json`。保存前に record のマスク処理を通し、Authorization / chatgpt-account-id を除去した。

## 実通信の予算

Phase 3 の上限: Codex 12回、Claude 7回。直接 HTTP の実測は **Codex 2回、Claude 2回**。どちらも baseline と検索の各1回。開発・ループ・変換試験は fixtures / FakeProvider で行い、追加の実 API 送信はしていない。

Claude は最初の資格情報読み取りで期限切れになり、送信前に停止した（この時点の直接通信0回）。ユーザーの「CLIの更新を許可します」を受けて公式 Claude CLI を Haiku の短い pong、max-turns 1、no-session-persistence、tools 無しで **1ターン**起動し、exit 0 / pong を確認。その後、上記2回の直接 HTTP が成功した。XHarness 自身は資格情報編集・refresh をしていない。

公式 CLI 内部の HTTP 回数は捕捉できないため、**Claude の総 HTTP 回数を確定値としては報告できない**。CLI の1ターン用に保守的に3枠を予約し、ローカル予算台帳は **Codex 2/12、Claude 5/7** を消費済みとしている。予約3枠は内部通信が3回だったことの証明ではなく、総 HTTP 回数が厳密に7以下だったことも検証できていない。この不確実性を残し、以後の追加送信は行わなかった。

`scripts/phase3-web-probe.ts` の台帳は `.out/phase3-budget/`（gitignore）に送信前の枠を排他的に作る。直接要求の再実行時も台帳を引き継ぐ。失敗送信も枠を戻さない。期限切れで送信前に止まった試行は枠を消費しない。

## 最終検証

Windows / PowerShell 7、ローカル Node 22.23.3 / pnpm 10.34.6。

- `pnpm install --frozen-lockfile`: 成功。Undici 7.30.0 を dispatcher のために追加。外部 API は引き続き Node 標準 fetch、プロバイダ SDK は使わない。
- `pnpm test`: **321件 / 33ファイル、全件成功、skip 0**。PowerShell 依存テストも実行。途中のテスト失敗（パッケージ対象の期待値、検索引用欄が空の場合の成功判定、テストのイベント名と空ツールの期待値）は修正して再実行済み。
- `pnpm typecheck` / `pnpm lint` / `pnpm build` / `pnpm build:headless`: 成功。
- headless のビルド成果物で `--fake --model codex:luna --effort low` → ping → Claude Haiku low に切替 → ping → Codex Luna high に切替 → ping → exit。3回とも pong、exit 0、stderr なし。実通信・認証読み取りなし。
- WebFetch の境界と WebSearch の録画再生は35件。モデル切替・fallback・history・usage のセッション統合2件も成功。
- 現在のローカル資格情報をメモリ内の検査値として、tracked / non-ignored untracked / main bundle / 検索報告の210ファイルを照合。一致0、検索録画の禁止ヘッダ0。秘密値は出力・保存していない。
- `git diff --check`: 成功。

## 設計・未実施

`docs/design-websearch.md` は最新 origin/main にも無い。ユーザー確認では別PCのローカルにあり、「一旦先に進めてください」と回答。**元文書の取り込み・削除は未完了**。今回の要件と実測から DESIGN.md §22 を暫定仕様として作成し、§9 の Web 権限と §12 の Web 設定を追記した。原文が取得できたら差分照合が必要。

実装・検証の限界:

- Codex cached モード、新しい Claude 検索版、Sonnet への代替は実通信していない。live / 基本版が両方使えたため追加送信は不要だった。
- Router の本物の429、実 API のプロバイダ跨ぎ・暗号化 reasoning の追加返送は Phase 3 では実施せず、Phase 0 の録画と単体・統合テストで確認。
- WebFetch の公開サイトへの実取得、Electron 画面での新機能操作、Phase 3 の portable exe 作成・別フォルダ起動は未実施。ビルドと core / IPC / headless の通信なし検証まで。
- `UiEvent.usage` は main から送るが、UsagePopover と `/usage` の表示は未実装。既存 renderer は usage イベントを表示しない。
- 設定のプロジェクトマージ、権限モード、コンパクション、サブエージェントは後続フェーズ。本実装ではモデルカタログの同梱初期値を使用し、ユーザーカタログの編集・更新は未実装。
- 独立した検索要求の hosted tool ブロックは親の履歴へ返さない。この会話分離と軽い検索モデル、Web 設定・取得上限は原文未取得の暫定仕様で、原文との一致を主張しない。
- 1コミット1目的の分割は未実施。差分は未コミットなので、コミットする際は Adapter / routing / Web / 記録などに小分けして秘密情報を再確認する。
