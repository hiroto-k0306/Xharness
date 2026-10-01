# Phase 0 作業進捗

実施日: 2026-10-01（日本時間）

現在の状態: **手順書の6項目に照合し、Phase 0 のゲート完了。Phase 1 未着手。** Opus は追加の C2 手順2で疎通成功。実更新・期限切れエラーは未確認。最終結果は末尾と [調査結果](phase0-findings.md) を参照。

## 完了: §1.4 と §2

- npm 名 `xharness`、strict / NodeNext / ES2023 の TypeScript 雛形を作成。
- Node.js 22.23.3、pnpm 10.34.6 で検証。TypeScript は lint ツールが対応する 6.0 系に固定。
- 秘密情報の再帰マスク、SSE の非同期読み取り、記録、使用量ヘッダ整理を実装。
- SSE は LF / CRLF / CR、UTF-8 の分割、複数 data 行、早期終了と中断に対応。
- AGENTS.md に従い、ローカル記録にも秘密情報を保存しない。
- 合成データを用いた11件のテスト、型検査、lint、整形検査で確認。

## 完了: C1 と X1（資格情報検査）

- `spike/claude/c1-creds.ts` と `spike/codex/x1-creds.ts` を追加。
- 値を表示せず、キー構造と型だけを出力する。Claude の期限、Codex の JWT の期限・プランのキー名を確認する。
- 既定のホーム配下を読み取り、明示設定がある場合は `CLAUDE_CONFIG_DIR` / `CODEX_HOME` を使用する。
- ファイルなし・読み取り失敗・不正 JSON / JWT を、秘密値を含まない状態名で報告する。
- この端末で両方の OAuth 資格情報を確認し、結果を `phase0-findings.md` に記録した。ファイルの書き換え・API 呼び出しはしていない。
- Claude の期限は 2026-10-01 17:08:30.496 JST。Codex の `id_token` は期限切れだが、アクセストークンの有効性は未確認。
- 合成データのテストは計18件が成功。型検査・lint・整形検査も成功。
- `pnpm test` は `spike/.out/` を除外し、検査用にコンパイルしたテストの二重実行を防ぐ。
- この実行環境では pnpm のコマンド解決と tsx の `uv_os_get_passwd` が失敗したため、Node.js 22 で各ツールを直接実行し、スクリプトは TypeScript で `spike/.out/compiled/` にコンパイルして実行した。

## 実測上の制限・引き継ぎ

- Opus は system なしで3回429、識別文ありで成功。識別文の必須性と自前指示の追加は Opus では未検証。Sonnet / Claude effort / Claude contextTokens も未検証。
- トークンの実更新・期限切れエラーは未観測。方針は自前 refresh を行わず公式 CLI に更新を委ねる。
- Ultra はユーザー承認で保留。暗号化推論の返送は保存済み応答の次ターン再生で確認済み。

Phase 1 に着手可能。本作業は Phase 0 で止める。未実測の事項は引き継ぎ、通信結果を得るまで断定しない。

## 今回: C2・C4 と Codex ソース調査

- C2 を1実行1リクエストで実装。30秒のタイムアウト、リダイレクト拒否、自動再試行なし。
- 使用量予算は `spike/.out/budget/` の番号付きファイルを排他的に作り、Claude 20 / Codex 25 件で制限する。通信失敗も1件として数える。この記録を削除するとカウントも失われるため、Phase 0 完了まで保持する。
- Haiku: system なし、識別文 + 自前 system の両方で HTTP 200 / `pong`。Opus: 1回だけ試し HTTP 429。モデルアクセス不可とは断定していない。
- C4 は追加リクエストなしで保存済みヘッダを読む。5h / 7d の utilization と reset を取得できた。
- 実レスポンスを `test/fixtures/claude/c2-*.json` に保存し、DESIGN.md §7.1 と調査記録に実測を反映。
- 実通信で、既存のマスクが数値のトークン使用数まで秘密として扱い、ヘッダの数字を過剰に伏せる不具合を発見。非負の整数である既知のトークン数だけを保持し、トークン文字列・アカウント類の ID は引き続きマスクするよう修正。
- 修正後に Haiku の最小応答を1回再取得。累計 Claude 4 / 20、Codex 0 / 25。custom と Opus の初回記録の数値は推測で復元していない。
- 7つのローカル記録 / fixtures を資格情報の秘密値と照合し、完全な秘密値が残っていないことを確認。organization / workspace の識別ヘッダも除去した。
- 実 SSE によるテキスト組み立て、不完全ストリーム、実429の再生、通信例外の秘密漏洩、予算の並列予約をテスト。合計23件が成功。
- Codex の公開ソース `rust-v0.159.0` を調査。端末の CLI 0.159.2 とは異なる点を明記した。[詳細](phase0-codex-source.md)。推論リクエストや refresh は実行していない。
- テスト対象から `.tools/` の調査用ソースを除外した。

Phase 0 全体は未完了。23件のテスト、型検査・lint・整形検査・diff の空白検査はすべて成功。
C4 の保存済みヘッダ表示も追加リクエストなしで確認済み。

## 今回: Claude C3 と Codex X2 / X6

- C3 の get_time 引数 JSON の分割を組み立て、tool_result 返送と最終テキストを確認した。両方 HTTP 200。
- 実引数 `Tokyo` を Asia/Tokyo に変換し、保存済み tool_use から返送を再開する `--resume-first` を追加。初回呼び出しの再送を避けた。
- 返した短い日付をモデルが誤読したため、ISO UTC と年月日順のローカル日時を JSON で返すよう修正。返送だけの再試験で、日付・時刻の一致を確認。
- C3 は計3リクエスト。累計 Claude 7 / 20。
- X2 は Luna / Sol / Astra 各1回、effort high、自前 instructions で HTTP 200 / pong / completed。累計 Codex 3 / 25。
- Codex の応答に Content-Type がなく、初回の検査は SSE を認識できなかった。保存済み Luna 応答を再解析して fixtures を修正。追加リクエストなし。
- X6 は保存済み応答を使い、5時間枠 / 週間枠の使用率・枠の長さ・リセット時刻を抽出。使用量ヘッダの抽出に used-percent / window-minutes を追加した。
- マスク処理は Codex の cached / reasoning 等の数値カウンタを保持し、details 内の秘密キーはマスクする。ヘッダ秘密値の収集にも共通の判定を使用する。
- 実 Claude / Codex SSE を使用した変換テスト、途中終了、保存済み呼び出しの再開、Content-Type なし、使用量数値を検証するテストを追加。
- 両方の資格情報ファイルは読み取りだけ。refresh や公式 CLI の推論実行はしていない。

Phase 0 は継続中。31件のテスト、型検査・lint・整形検査・diff の空白検査が成功。
21個のローカル記録 / fixtures を両方の資格情報の秘密値と照合し、完全な秘密値が残っていないことを確認した。

## 今回: Codex X3 / X5

- Luna の get_time 関数呼び出し往復を2リクエストで確認。両方 HTTP 200、返した Tokyo の時刻と最終テキストが一致。
- 確定したネイティブ output item をそのまま次の input に追加し、call_id を一致させて function_call_output を返す。今回 reasoning item は返らず、暗号化された推論の返送確認は未完了。
- モデル一覧を1回取得し、HTTP 200、10モデル、ETag、context_window と supported_reasoning_levels を記録した。
- Luna / Sol / Astra の contextTokens を、返された設定の272000に更新。入力上限の実負荷試験ではない。
- Luna の advertised effort は low / medium / high / xhigh / max。初期カタログの記載との差を残し、high 以外の呼び出し受理は X4 待ちとした。
- メタデータの公開 token budget 数値を保持し、その中の秘密キーは引き続きマスクする。
- 実レスポンスによる関数往復の再生・モデル一覧の読み取り・メタデータのマスクをテスト。

累計 Claude 7 / 20、Codex 6 / 25。Phase 0 を継続し、Phase 1 には進まない。
36件のテスト、型検査・lint・整形検査・diff の空白検査が成功。
29個のローカル記録 / fixtures を両方の資格情報の秘密値と照合し、完全な秘密値が残っていないことを確認した。

## 今回: Codex X4 と X3 の追加確認

- X4 は8リクエスト、全件 HTTP 200 / pong。Sol は low / medium / high / xhigh / max、Astra / Luna は low / high / max を確認した。high の結果は X2 を再利用。
- Astra / Luna の medium / xhigh は一覧への掲載のみ。カタログで実測と区別した。
- CLI ソースで Ultra の通常推論用 effort への変換を確認。X5 の Sol / Astra は xhigh に解決する。raw ultra の受理や自動委譲は未検証で、ハーネスでの扱いは未確定。
- max のテキスト応答は3モデルとも暗号化推論 item を返した。
- X3 の残り2リクエストで Luna max の関数往復を試し、両方 HTTP 200、時刻・日付の一致を確認。ただし初回は function_call のみで、暗号化推論を含む返送は未確認。X3 は計4リクエストで区切った。
- 実 X4 fixtures 8件の再生、wire effort の一致、推論 item の読み取り、未対応値の送信防止、max 関数往復の再生をテスト。

累計 Claude 7 / 20、Codex 16 / 25。Phase 0 は継続中。
46件のテスト、型検査・lint・整形検査・diff の空白検査が成功。
51個のローカル記録 / fixtures を両方の資格情報の秘密値と照合し、完全な秘密値が残っていないことを確認した。

## 今回: R2 ストリーム中断

- 各プロバイダへ1リクエスト、最初の SSE イベント後に AbortController を発火。両方 HTTP 200 / AbortError。
- Claude は message_start 後に中断し4イベント、Codex は response.created 後に中断し1イベントを保存。どちらも完了イベントなし。
- Codex の Content-Type なし SSE も逐次読み取りで中断できた。中断指示後の受信済みバッファを、完了応答と区別する。
- 例外の既知の型名だけを記録し、メッセージ・スタック・未知の型名は保存しない。
- 実際の Ctrl+C キー操作と tool 実行中の中断は未検証。Phase 0 の試験は通信層のみ。
- 実部分イベントの再生、未完了判定、秘密を含む例外の除去をテスト。

累計 Claude 8 / 20、Codex 17 / 25。資格情報は読み取りのみ。Phase 0 は継続中。
49件のテスト、型検査・lint・整形検査・diff の空白検査が成功。
55個のローカル記録 / fixtures を両方の資格情報の秘密値と照合し、完全な秘密値が残っていないことを確認した。

## 最終: Phase 0 ゲート完了

- ユーザーが公式 CLI による更新試験と、Ultra を通常 effort から除いて保留する設計変更を承認。AGENTS.md / DESIGN.md / catalog に反映。
- 保存済み Luna max の reasoning / encrypted_content と message をそのまま次ターンに返し、HTTP 200 / pong / completed。初回の再送を避けて1リクエストで確認。
- Opus の再確認も429。計2回で停止し、成功・利用不可のどちらも断定しない。
- Claude / Codex CLI は短い pong で成功。ただし期限前で、access / refresh は両方変化なし。実更新の成功とは扱わない。
- Codex CLI の最初の2実行は、追加した再試行抑止設定が内蔵 provider の上書き禁止に触れて起動時に失敗。ソースで原因を確認し、設定を除去して成功。
- CLI 生出力は表示・保存せず、終了状態・変化の有無・期限だけ記録。スクリプト自身は資格情報を編集しない。
- CLI 起動後に資格情報を読み直し、両プロバイダで直接 HTTP 200 / pong。初回 fixture は保持し、追加応答を c5-after-cli / x7-after-cli に保存。
- 手順書の6つの完了条件をすべて確認。期限切れへの対処は方針確定が条件であり、実更新・期限切れエラーは未実測として明記。

予約数は Claude 11 / 20、Codex 22 / 25。直接試験は Claude 10件・Codex 19件、ほかに CLI 1 / 3起動を予約。CLI 内部 HTTP 回数は未観測。
Phase 1 の実装は開始していない。
最終検査: 50件のテスト、型検査・lint・整形検査・diff の空白検査が成功。
64個のローカル記録 / fixtures を両方の資格情報の秘密値と照合し、完全な秘密値が残っていないことを確認した。

## 追加: ユーザー指定の C2 手順2で Opus を確認

- system の第1ブロックに識別文のみを入れ、Opus 5.5 を1回試験。HTTP 200 / pong / end_turn。
- `c2-opus-identity.json` に応答を保存。system なしの既存429記録は保持した。
- catalog の Opus を verified: true に更新。effort の受理範囲は未確認。
- 試験時刻が異なるため、以前の429の原因や識別文の必須性は断定しない。
- 使用率の生値は5h 0.37、7d 0.83。予約数は Claude 12 / 20、Codex 22 / 25。
- 実 Opus SSE の再生テストを追加し、51件のテスト・型検査・lint・整形検査・diff の空白検査が成功。66個のローカル記録 / fixtures に秘密値の完全一致がないことを確認。

## 追加: 元の C2 手順1で Opus を再確認

- ユーザー指定で system なし、想定ヘッダ、max_tokens: 64、同じ pong プロンプトを1回試験。
- HTTP 429 / rate_limit_error。Retry-After なし、x-should-retry: true。自動再試行はしない。
- `c2-opus-none-recheck.json` に記録し、以前の system なしの記録と識別文ありの成功記録を保持。
- 識別文ありの成功後でも元の条件は失敗した。識別文ありの構成を採用し、429の原因は未確定とする。
- 予約数は Claude 13 / 20、Codex 22 / 25。
- 再確認の実429を再生するテストを追加。52件のテスト・型検査・lint・整形検査・diff の空白検査が成功。68個の記録に秘密値の完全一致がないことを確認。
