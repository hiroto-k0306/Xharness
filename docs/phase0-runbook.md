# Phase 0 手順書: OAuth 疎通確認

対象: 別端末で実装する人と、実装を担当するコーディングエージェント(Codex / GPT-6.1 Sol)
関連: [DESIGN.md](../DESIGN.md) §7(Adapter 詳細)、§13(実装フェーズ)、§21.9(モデルカタログ)

---

## 0. このフェーズの目的

XHarness の設計は「公式 CLI がログイン時に保存した OAuth トークンで、Claude と Codex の API を直接呼べる」ことを前提にしている。ただし、そのためのエンドポイント・ヘッダ・制約は**非公開で、設計書の値は未検証**。

Phase 0 では、本体を作り始める前に**最小のスクリプトで実際に通信し、設計書の「要確認」を事実で埋める**。ここで想定と違う結果が出たら、本体の設計を見直す。

### 完了条件(すべて満たしたら Phase 1 へ)

- [x] Claude: テキスト応答とツール呼び出しの往復が、OAuth トークンで成功する
- [x] Codex: テキスト応答と関数呼び出しの往復が、OAuth トークンで成功する
- [x] 両方の SSE ストリームを `test/fixtures/` に保存した(秘密情報を除去済み)
- [x] トークンの期限切れへの対処方法を決めた(§C5)
- [x] 使用量(5時間枠・週間枠)を取得できるかどうかが分かった
- [x] [phase0-findings.md](phase0-findings.md) を埋め、DESIGN.md §7・§21.9 の「要確認」を確定値に書き換えた

判定: 2026-10-01、Phase 0 のゲート完了。期限切れへの対処は公式 CLI に委ねる方針で確定し、両 CLI の起動後に直接疎通を再確認した。トークンの実更新・期限切れエラーは未実測。Opus は2回とも429。これらの制限は [調査結果](phase0-findings.md) に残す。Phase 1 は未着手。

### 使用量の予算

Phase 0 全体で **Claude 20 回・Codex 25 回まで**のリクエストに収める。プロンプトは1文、出力上限は小さく(256 トークン程度)する。同じ失敗を繰り返さず、2回失敗したら止めて原因を調べる。

---

## 1. 準備(新しい端末で1回だけ)

### 1.1 インストール(すべて無料)

PowerShell で実行する。インストール済みのものは飛ばしてよい。

```bash
winget install OpenJS.NodeJS.LTS
```

```bash
winget install Git.Git
```

```bash
winget install Microsoft.PowerShell
```

```bash
corepack enable
```

```bash
corepack prepare pnpm@latest --activate
```

公式 CLI(ログインとトークン取得のために使う):

```bash
npm install -g @anthropic-ai/claude-code
```

```bash
npm install -g @openai/codex
```

### 1.2 ログイン

```bash
claude login
```

```bash
codex login
```

- Claude は **Pro / Max のアカウント**でログインする(API キーではない)
- Codex は **「Sign in with ChatGPT」**を選ぶ(API キーではない)
- それぞれ1回ずつ短い質問をして、公式 CLI 自体が動くことを確認しておく

### 1.3 リポジトリの用意

この端末で作った設計一式(`DESIGN.md`、`AGENTS.md`、`docs/`、`catalog/`、`brand/`、`mockup/`)を新しいフォルダ `xharness/` にコピーし、git 管理を始める。

```bash
git init
```

`.gitignore` を作り、最低限これを入れる:

```gitignore
node_modules/
dist/
out/
.env*
# 生のレスポンス(マスク前)は絶対にコミットしない
spike/.out/
*.credentials.json
auth.json
```

### 1.4 疎通確認用プロジェクトの雛形

```bash
pnpm init
```

```bash
pnpm add -D typescript tsx vitest @types/node
```

`package.json` の `scripts` に追加する(スクリプト本体は §2 以降で作る):

```json
{
  "spike:claude:creds": "tsx spike/claude/c1-creds.ts",
  "spike:claude:text":  "tsx spike/claude/c2-text.ts",
  "spike:claude:tool":  "tsx spike/claude/c3-tool.ts",
  "spike:claude:usage": "tsx spike/claude/c4-usage.ts",
  "spike:codex:creds":  "tsx spike/codex/x1-creds.ts",
  "spike:codex:text":   "tsx spike/codex/x2-text.ts",
  "spike:codex:tool":   "tsx spike/codex/x3-tool.ts",
  "spike:codex:effort": "tsx spike/codex/x4-effort.ts",
  "spike:codex:models": "tsx spike/codex/x5-models.ts",
  "spike:codex:usage":  "tsx spike/codex/x6-usage.ts"
}
```

`tsconfig.json` は `"strict": true`、`"module": "NodeNext"`、`"target": "ES2023"` で作る。

---

## 2. 共通部品(最初に作る)

`spike/lib/` に置く。本体(Phase 1)でも流用するので、きちんと型を付けて作る。

| ファイル | 役割 | 要件 |
|---|---|---|
| `mask.ts` | 秘密情報のマスク | 文字列を `先頭6文字…` にする関数。オブジェクトを再帰的に走査し、キー名が `token`・`authorization`・`account_id`・`secret` などを含む値をマスクする関数 |
| `sse.ts` | SSE の読み取り | `fetch` のレスポンス本文を読み、`{ event, data }` を1件ずつ返す非同期イテレータ。`data:` が複数行のときは連結する |
| `record.ts` | 記録 | (1) 生の内容を `spike/.out/<日時>-<名前>.json` に保存(git 管理外) (2) **ヘッダからトークン類を除いたもの**を `test/fixtures/<provider>/<名前>.json` に保存。保存前に `mask.ts` を必ず通す |
| `headers.ts` | ヘッダの記録 | レスポンスヘッダをすべて記録し、名前に `ratelimit`・`limit`・`usage`・`reset`・`retry` を含むものを目立つように出力する |

**完了確認**: `mask.ts` の単体テストを Vitest で書き、トークンらしき文字列がどんな階層にあってもマスクされることを確かめる。

---

## 3. Claude の確認

設計書の想定値(DESIGN.md §7.1)。**すべて未検証。違っていたら実際の値を記録する。**

| 項目 | 想定値 |
|---|---|
| エンドポイント | `POST https://api.anthropic.com/v1/messages` |
| 認証 | `Authorization: Bearer <accessToken>`(`x-api-key` は使わない) |
| 追加ヘッダ | `anthropic-version: 2023-06-01`、`anthropic-beta: oauth-2025-04-20` |
| system の制約 | 先頭に Claude Code の識別文(`You are Claude Code, Anthropic's official CLI for Claude.`)が必要な可能性がある |
| 資格情報 | `~/.claude/.credentials.json` の `claudeAiOauth.{accessToken, refreshToken, expiresAt}` |

### C1. 資格情報の構造を確認する(リクエストなし)

- `~/.claude/.credentials.json` を読み、**キーの構造と値の型だけ**を出力する(値はマスク)
- `expiresAt` があれば、日時に直して「あと何分で期限切れか」を出す
- ファイルが無い場合は、保存場所を探して記録する(Windows の資格情報マネージャーに入っている可能性もある)

### C2. テキスト応答(リクエスト 1〜4 回)

- モデル: `claude-haiku-4-5-20251001`(使用量の節約のため)、`max_tokens: 64`、`stream: true`
- プロンプト: `"Reply with the single word: pong"`
- 次の順で試し、**最初に成功した組み合わせ**を記録する:
  1. 想定ヘッダ + system なし
  2. 想定ヘッダ + system の1ブロック目に識別文
  3. 2 + 識別文の後ろに2ブロック目として自前の system(`"Answer in Japanese."`)
- 3 が成功すれば、自前のシステムプロンプトを後ろに足せることが確定する(DESIGN.md §7.1)
- 失敗したら、ステータスコードとエラー本文をそのまま記録する
- SSE のイベントの種類と順番(`message_start` → `content_block_start` → …)を記録する
- **最後に1回だけ** `claude-opus-5-5` でも同じ確認をし、Opus が使えることを確かめる

### C3. ツール呼び出しの往復(リクエスト 2〜4 回)

- ツールを1つ定義する: `get_time`(引数 `{ timezone: string }`)
- プロンプト: `"What time is it in Tokyo? Use the tool."`
- 1回目の応答で `tool_use` ブロックが返ること、`input_json_delta` が分割されて届くことを確認する
- `tool_result` を返して2回目を送り、最終的なテキストが返ることを確認する
- 往復の SSE を `test/fixtures/claude/tool-roundtrip.json` に保存する
- 余裕があれば: system と tools の末尾に `cache_control: { type: "ephemeral" }` を付け、2回目のレスポンスの usage に `cache_read_input_tokens` が出るか確認する

### C4. 使用量の取得(追加リクエストなし。C2・C3 のヘッダを使う)

- C2・C3 のレスポンスヘッダから、レート制限・使用量らしきものを洗い出す
- 5時間枠・週間枠の**使用率やリセット時刻**が取れるかを記録する
- 取れない場合は、公式 CLI に使用量を表示する機能があるかを調べ(`claude` の対話モードで `/usage` など)、その表示がどこから来ているかを推測して記録する(推測は推測と明記する)

### C5. トークンの期限切れへの対処(リクエスト 0〜2 回)

設計の方針(DESIGN.md §14): v1 では**自前でトークンを更新せず、公式 CLI に更新させる**。リフレッシュトークンが使うたびに入れ替わる方式だと、ハーネスと公式 CLI が別々に更新したときに片方がログアウト状態になるため。

確認すること:
1. C1 の `expiresAt` を見て、期限切れまでの時間を記録する
2. 期限切れ後(または期限が近いとき)に `claude -p "ping"` を1回実行し、`.credentials.json` の `accessToken` と `expiresAt` が新しくなるかを確認する(値そのものではなく、変わったかどうかと新しい期限だけ記録する)
3. 更新後のトークンで C2 が通ることを確認する
4. 期限切れのトークンで送った場合のステータスコードとエラー本文を記録する(ハーネスが「期限切れ」を見分けるため)

期限切れまで時間がかかる場合は、2〜4 を後回しにして先に Codex へ進んでよい。

---

## 4. Codex の確認

設計書の想定値(DESIGN.md §7.2)。**すべて未検証。**

| 項目 | 想定値 |
|---|---|
| エンドポイント | `POST https://chatgpt.com/backend-api/codex/responses`(Responses API 形式、stream 必須) |
| 認証 | `Authorization: Bearer <access_token>` |
| 追加ヘッダ | `chatgpt-account-id`、`OpenAI-Beta: responses=experimental`、`originator`、`session_id` など |
| ボディの制約 | `store: false` が必須の可能性。`instructions` に制約がある可能性 |
| 資格情報 | `~/.codex/auth.json` の `tokens.{access_token, refresh_token, id_token, account_id}` |

**最初にやること**: Codex CLI はオープンソース(GitHub の `openai/codex`)なので、推測で試す前に**ソースコードで次を確認する**。これが一番確実で、使用量の節約にもなる。

- ChatGPT ログイン時にリクエストを送る URL
- 付けているヘッダ(名前と値の作り方)
- リクエストボディの組み立て方(`instructions`、`input`、`tools`、`reasoning`、`store`、`include`)
- トークン更新の方法と、`auth.json` への書き戻し方
- レート制限・使用量のヘッダの読み取り方
- モデル一覧を取得している箇所があるか

確認した内容は、ソースのファイル名(とバージョンかコミット)付きで [phase0-findings.md](phase0-findings.md) に記録する。

### X1. 資格情報の構造を確認する(リクエストなし)

- `~/.codex/auth.json` を読み、キーの構造と値の型だけを出力する(値はマスク)
- `id_token` があれば JWT のペイロード部分だけをデコードし、**期限(`exp`)とプラン名らしき項目のキー名**を記録する(メールアドレスなどの値は出さない)

### X2. テキスト応答(リクエスト 1〜4 回)

- モデル: `gpt-6-luna`(使用量の節約のため)。Luna は effort が High 以上のみなので `reasoning.effort` は `high`(値の表記はソースで確認)
- `input`: ユーザーメッセージ1件 `"Reply with the single word: pong"`
- `instructions`: まず短い自前の文(`"You are a helpful assistant."`)で試す。拒否されたら、Codex CLI と同じ既定の指示文が必要かどうかを確認する
- 成功した組み合わせ(ヘッダ・ボディ)と、SSE のイベントの種類と順番を記録する
- **最後に1回だけ** `gpt-6.1-sol` と `gpt-6-astra` でも同じ確認をし、どちらも使えることを確かめる

### X3. 関数呼び出しの往復(リクエスト 2〜4 回)

- C3 と同じ `get_time` ツールを Responses API の形式(`type: "function"`)で定義する
- 1回目の応答で `function_call` が返ることを確認する
- `function_call_output` を返して2回目を送り、最終的なテキストが返ることを確認する
- `store: false` の場合、2回目に1回目の出力(`reasoning` の暗号化された内容を含む)をどう渡す必要があるかを確認する(`include: ["reasoning.encrypted_content"]`)
- 往復の SSE を `test/fixtures/codex/tool-roundtrip.json` に保存する

### X4. effort の値(リクエスト 3〜8 回)

- 公式ドキュメント上の名前は Light / Low / Medium / High / Extra High / Max / Ultra。**API に渡す実際の値**をソースで確認してから、各モデルで受け付けられるかを試す
- 全組み合わせを試す必要はない。`gpt-6.1-sol` で全段階、Astra と Luna は両端(最小・最大)だけ試す
- 結果を [catalog/models.yaml](../catalog/models.yaml) の `efforts` に反映する

### X5. モデル一覧の取得(リクエスト 0〜2 回)

- ソースでモデル一覧を取得している箇所があれば、そのエンドポイントを1回呼んで内容の形を記録する
- 無ければ「取得手段なし」と記録する(DESIGN.md §21.9 は手動更新で運用する)

### X6. 使用量の取得(追加リクエストなし。X2〜X4 のヘッダを使う)

- C4 と同じく、5時間枠・週間枠の使用率とリセット時刻が取れるかを記録する

### X7. トークンの期限切れへの対処

- C5 と同じ方針・同じ確認を Codex でも行う(`codex exec "ping"` で公式 CLI に更新させる)

---

## 5. 横断の確認

### R1. レート制限(429)

- **わざと使用量を使い切らない。** 自然に 429 に当たった場合だけ、ステータス・ヘッダ・本文を記録する
- 当たらなかった場合は、ソース(Codex)やエラー形式のドキュメントから、429 のときに何が返るかを推測で記録する(推測と明記)

### R2. 中断

- C2・X2 のストリームの途中で `AbortController` で中断し、例外の種類を記録する(DESIGN.md §8 の Ctrl+C 対応で使う)

---

## 6. 成果物

| 成果物 | 場所 |
|---|---|
| 疎通確認スクリプト | `spike/claude/*.ts`、`spike/codex/*.ts`、`spike/lib/*.ts` |
| 共通部品のテスト | `spike/lib/*.test.ts` |
| 実レスポンス(秘密情報を除去) | `test/fixtures/claude/`、`test/fixtures/codex/` |
| 調査結果 | [docs/phase0-findings.md](phase0-findings.md)(テンプレートを埋める) |
| 設計書の更新 | DESIGN.md §7.1・§7.2 の表を確定値に、§16.7・§21.9 の「要確認」を更新 |
| モデルカタログの更新 | catalog/models.yaml の `efforts`・`contextTokens`・`verified` |

**コミット前の確認**: `git diff --cached` で、`Bearer`・`eyJ`(JWT の先頭)・`sk-`・`account` などの文字列が入っていないか検索する。

```powershell
git diff --cached | Select-String -Pattern "Bearer |eyJ|sk-ant|account_id"
```

何か出たら、コミットせずにマスク処理を直す。

---

## 7. うまくいかないとき

| 症状 | まず疑うこと |
|---|---|
| 401 / 403 | トークンの期限切れ(C1・X1 の期限を確認)、ヘッダの不足、`x-api-key` を付けてしまっている |
| 400 で system / instructions について言われる | 識別文や既定の指示文が必要(C2・X2 の手順を順に試す) |
| 404 | エンドポイントの URL の誤り。Codex はソースの URL と照合する |
| SSE が途中で止まる | `stream: true` の付け忘れ、読み取り処理が `\r\n` 区切りに対応していない |
| 公式 CLI がログアウト状態になった | ハーネス側でトークンを書き換えていないか確認。`claude login` / `codex login` をやり直す |

**どちらかのプロバイダが OAuth で直接呼べないと分かった場合**は、Phase 1 に進まず、結果を持って設計者(人間)に相談する。代わりの案(公式 CLI をサブプロセスとして呼ぶ方式など)を検討し直す必要がある。

---

## 8. Codex への最初の指示(例)

別端末で Codex を起動したら、最初にこのように伝える:

```
AGENTS.md と docs/phase0-runbook.md を読んで、Phase 0 の §1.4 と §2(共通部品)から始めてください。
共通部品ができたら止めて、mask.ts のテスト結果を報告してください。
API へのリクエストを送る前には、送る内容(URL・ヘッダ名・ボディ)を見せて確認を取ってください。
```

以降は §3(Claude)→ §4(Codex)→ §5 の順に、1項目ずつ進めて報告させる。
