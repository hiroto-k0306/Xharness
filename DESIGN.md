# XHarness 設計書 (v0.1)

Claude (Pro/Max) と GPT (ChatGPT Plus/Pro) のサブスク枠を直接利用する、Claude Code ライクな汎用エージェントハーネス。

- 言語: TypeScript (Node.js 22+)
- 配布形態: Windows デスクトップアプリ (.exe / Electron) — §16, §17
- 利用形態: 個人利用・ローカル実行
- ステータス: 設計のみ。実装は別端末で行う
- UIモック: [mockup/index.html](mockup/index.html)(ブラウザで開くだけで確認可能)

---

## 1. 目的とスコープ

### やること
- デスクトップアプリ(exe)上で、ファイル操作・シェル実行・検索などのツールを使う汎用エージェント
- エージェントループの各ステップを可視化するターミナル風UI(§16)
- Claude / GPT をセッション中に切り替え、またはサブエージェントとして使い分け
- 両モデルともサブスクのOAuthトークンで呼び出す(APIキー課金なし)

### やらないこと(v1)
- macOS / Linux 向けビルド(Electron なので後から追加可能)
- 自動アップデート(v2で検討)
- MCPクライアント(v2で検討)
- マルチユーザー・サーバー運用

---

## 2. 前提と制約

| 項目 | 内容 |
|---|---|
| 認証 | 公式CLI (`claude` / `codex`) でログイン済みのトークンを再利用する |
| エンドポイント | どちらも**非公開・無保証**。仕様変更で壊れる前提で、Adapter層に閉じ込める |
| レート制限 | サブスク枠(5時間ウィンドウ・週間上限など)。429を前提に設計する |
| 規約 | 個人利用の範囲で確認済み(ユーザー確認) |

> ⚠️ 本書の認証・エンドポイントの具体値は設計者の知識ベースであり、**未検証**。Phase 0 で必ず実機確認すること(§13)。

---

## 3. 全体アーキテクチャ

```
┌──────────────────────────────────────────────┐
│ Renderer (React)  ※Electron レンダラプロセス      │
│  会話ビュー / ループ可視化 / レシート / 使用量       │
└───────────────┬──────────────────────────────┘
                │ IPC (preload で公開した型付きAPIのみ)
┌───────────────▼──────────────────────────────┐
│ ─── ここから下はすべて Electron メインプロセス ───   │
└───────────────┬──────────────────────────────┘
                │
┌───────────────▼──────────────────────────────┐
│ Session  (履歴・現在のモデル・設定・使用量)         │
└───────────────┬──────────────────────────────┘
                │
┌───────────────▼──────────────────────────────┐
│ Agent Loop                                    │
│  model呼出 → tool_use → 権限確認 → 実行 → 結果投入 │
└──┬─────────────┬──────────────┬──────────────┘
   │             │              │
┌──▼─────────┐ ┌─▼──────────┐ ┌─▼────────────┐
│ Provider    │ │ Tool        │ │ Context       │
│ Router      │ │ Registry    │ │ Manager       │
└──┬─────┬───┘ └─┬──────────┘ └──────────────┘
   │     │       │ Permission Gate
┌──▼──┐┌─▼───┐   ▼
│Claude││Codex│  Read/Write/Edit/Bash/Grep/Glob/WebFetch/Task
│Adapt.││Adapt│
└──┬──┘└─┬───┘
   │     │
┌──▼─────▼───────────┐
│ Auth (TokenStore)   │  ~/.claude/.credentials.json
│  読込・期限確認・更新  │  ~/.codex/auth.json
└────────────────────┘
```

---

## 4. ディレクトリ構成

```
xharness/
├─ package.json
├─ electron.vite.config.ts  # electron-vite (main / preload / renderer を一括ビルド)
├─ electron-builder.yml     # exe パッケージ設定 (§17)
├─ tsconfig.json
├─ resources/
│  ├─ icon.ico              # brand/icon.svg から生成 (§16.10)
│  └─ fonts/                # Silkscreen, JetBrains Mono を同梱(オフライン動作のため)
├─ src/
│  ├─ preload/
│  │  └─ index.ts           # contextBridge で型付き API だけを公開
│  ├─ renderer/             # React + CSS Modules (§16)
│  │  ├─ App.tsx
│  │  ├─ theme.css          # カラートークン・フォント
│  │  ├─ components/
│  │  │  ├─ TitleBar.tsx    # フレームレスウィンドウのタイトルバー
│  │  │  ├─ Sidebar.tsx     # セッション履歴 (§16.6)
│  │  │  ├─ WorkspacePicker.tsx  # フォルダ/リポジトリ選択 (§18)
│  │  │  ├─ UsagePopover.tsx     # 使用量の折りたたみ表示 (§16.7)
│  │  │  ├─ Hero.tsx        # ピクセルロゴ + タグライン + 統計
│  │  │  ├─ PhaseBar.tsx    # 計画 → 実装 → レビュー (§16.9)
│  │  │  ├─ StepTabs.tsx    # 1/6 … 6/6 のステップ表示
│  │  │  ├─ ModelPicker.tsx # 右下のモデル切替 (§16.8)
│  │  │  ├─ Transcript.tsx  # 会話ビュー
│  │  │  ├─ LoopFlow.tsx    # ループ可視化(ノード + 矢印 + 注釈)
│  │  │  ├─ Receipts.tsx    # ステップログ表
│  │  │  ├─ AgentsPanel.tsx # サブエージェント一覧
│  │  │  ├─ PermissionDialog.tsx
│  │  │  └─ PromptLine.tsx  # `~/project ❯ ` 形式の入力欄
│  │  └─ store.ts           # Zustand。メインからのイベントを反映
│  └─ main/                 # Electron メインプロセス = エージェント本体
│     ├─ index.ts           # BrowserWindow 生成、IPC 登録
│     ├─ ipc.ts             # renderer ⇄ core のブリッジ
│     ├─ headless.ts        # UI なしで core を動かすデバッグ用 CLI
│     ├─ commands.ts        # /model /clear /compact /usage など
│     ├─ core/
│     │  ├─ types.ts        # 内部メッセージ形式 (§5)
│     │  ├─ session.ts
│     │  ├─ agent-loop.ts   # §8
│     │  ├─ events.ts       # ループ→UI へのイベント (§16.4)
│     │  └─ receipts.ts     # ステップ記録 (§16.5)
│     ├─ providers/
│     │  ├─ provider.ts     # Provider インターフェース (§6)
│     │  ├─ router.ts       # モデル選択・フォールバック (§11)
│     │  ├─ claude/
│     │  │  ├─ adapter.ts
│     │  │  ├─ convert.ts   # 内部形式 ⇄ Messages API
│     │  │  └─ stream.ts    # SSE パース
│     │  └─ codex/
│     │     ├─ adapter.ts
│     │     ├─ convert.ts   # 内部形式 ⇄ Responses API
│     │     └─ stream.ts
│     ├─ auth/
│     │  ├─ token-store.ts  # 共通インターフェース
│     │  ├─ claude-oauth.ts
│     │  └─ codex-oauth.ts
│     ├─ tools/
│     │  ├─ registry.ts
│     │  ├─ read.ts / write.ts / edit.ts
│     │  ├─ bash.ts         # Windows では PowerShell
│     │  ├─ grep.ts / glob.ts
│     │  ├─ web-fetch.ts
│     │  └─ task.ts         # サブエージェント起動 (§10)
│     ├─ permissions/
│     │  └─ gate.ts         # §9
│     ├─ workflow/          # §20
│     │  ├─ phases.ts       # 段階の状態機械
│     │  ├─ plan-tools.ts   # SubmitPlan / UpdatePlan / RequestReview / SkipPlan
│     │  ├─ review.ts       # 差分収集と reviewer 起動
│     │  ├─ scheduler.ts    # 項目の依存解決・並列実行・統合 (§21)
│     │  └─ plan-validate.ts # 計画の検証(循環・ファイル重複・枠) (§21.3)
│     ├─ hooks/             # §19.10
│     │  ├─ registry.ts
│     │  └─ shell-hook.ts
│     ├─ workspace/         # §18
│     │  ├─ workspace.ts    # フォルダを開く・最近使った一覧
│     │  ├─ git.ts          # git コマンドのラッパ(status, branch, clone)
│     │  └─ worktree.ts     # セッション用 worktree の作成・片付け
│     ├─ sessions/
│     │  └─ store.ts        # セッション一覧の索引・検索・再開 (§18.4)
│     ├─ context/
│     │  ├─ project-memory.ts  # AGENTS.md / CLAUDE.md 読込
│     │  └─ compactor.ts    # 履歴圧縮
│     └─ config/
│        └─ config.ts       # §12
├─ prompts/
│  └─ system.md             # 共通システムプロンプト
└─ test/
   ├─ convert.*.test.ts     # 変換の単体テスト(最重要)
   └─ fixtures/             # 実レスポンスの録画
```

**依存の向き**: `src/main/core`・`providers`・`auth`・`tools` などは **electron を import しない**純粋な Node コードにする。UI なしでテストや `headless.ts` から動かせるようにするためで、Electron 依存は `main/index.ts` と `main/ipc.ts` だけに閉じ込める。

---

## 5. 内部メッセージ形式

Claude の content block 形式に寄せる(tool_use / tool_result が明示的で扱いやすいため)。各 Adapter が相互変換を担う。

```ts
type Role = "user" | "assistant";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string }        // base64
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string | ContentBlock[]; isError?: boolean }
  | { type: "reasoning"; provider: "claude" | "codex"; payload: unknown }; // 不透明。同一プロバイダにのみ返送

interface Message {
  role: Role;
  content: ContentBlock[];
  meta?: { provider?: string; model?: string; usage?: Usage };
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JSONSchema;   // 共通。Adapter が各形式へ変換
}

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

### 変換ルールの要点
- **tool_use ID**: Claude は `toolu_...`、Responses API は `call_...`。内部では元のIDを保持し、プロバイダをまたぐ場合は Adapter 側で ID マップを持つ
- **reasoning ブロック**: プロバイダ間で互換性なし。モデル切替時は**相手側へ送るときに除外**する(暗号化された推論を他社に送るとエラーになる)
- **system プロンプト**: 内部では Session が保持し、Messages 配列には入れない。Claude は `system`、Codex は `instructions` へ

---

## 6. Provider インターフェース

```ts
interface Provider {
  id: "claude" | "codex";
  models(): ModelInfo[];
  stream(req: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  maxOutputTokens?: number;
  reasoning?: { effort: "low" | "medium" | "high" };
}

type ProviderEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }   // 入力JSON確定後に1回
  | { type: "message_done"; message: Message; stopReason: StopReason; usage: Usage }
  | { type: "rate_limited"; retryAfterSec?: number; scope?: string }
  | { type: "error"; error: ProviderError };

type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
```

- Agent Loop は `ProviderEvent` だけを見る。HTTP・SSE・形式差はすべて Adapter 内に閉じる
- `rate_limited` を独立イベントにして Router がフォールバック判断できるようにする

---

## 7. Adapter 詳細 (要検証項目を含む)

### 7.1 ClaudeAdapter

| 項目 | 想定値(要検証) |
|---|---|
| エンドポイント | `POST https://api.anthropic.com/v1/messages` (stream: true)。C2 の Haiku で確認済み |
| 認証ヘッダ | `Authorization: Bearer <accessToken>` で Haiku の C2 成功。`x-api-key` は使っていない |
| 追加ヘッダ | C2 の成功時は `content-type: application/json`、`anthropic-version: 2023-06-01`、`anthropic-beta: oauth-2025-04-20`。省略試験は未実施で、必要最小集合は未確定 |
| system 制約 | Haiku の C2 / C3 は system なしで成功。C2 は識別文を第1ブロック、自前プロンプトを第2ブロックに置いた場合も受理。ほかのモデルは未確認 |
| 資格情報 | `~/.claude/.credentials.json` の `claudeAiOauth.{accessToken, refreshToken, expiresAt}`(Windows/Linux。macOSはキーチェーン) |
| プロンプトキャッシュ | system と tools 末尾、直近メッセージに `cache_control` を付与(枠節約に効く) |

ストリーム処理: `content_block_start` / `content_block_delta`(`text_delta`, `input_json_delta`, `thinking_delta`)/ `content_block_stop` / `message_delta`(stop_reason, usage)を組み立てる。

C2 の実測: Haiku は `pong` / `end_turn`、Opus 5.5 は2回の試行とも HTTP 429。Opus の疎通成功は未確認で、追加試行を停止した。
使用量ヘッダとして `anthropic-ratelimit-unified-{5h,7d}-utilization` と `-reset` を確認。
C5 の CLI 起動は Haiku で成功し、起動後の読み直しも HTTP 200。期限前のためトークンは変化せず、実更新・期限切れエラーは未実測。自前 refresh は行わず、公式 CLI に更新を委ねる。
根拠と試験条件: [docs/phase0-findings.md](docs/phase0-findings.md)。Phase 0 のゲートは完了。

### 7.2 CodexAdapter

| 項目 | 想定値(要検証) |
|---|---|
| エンドポイント | `POST https://chatgpt.com/backend-api/codex/responses`。X2 の3モデルで stream: true の成功を確認 |
| 認証ヘッダ | `Authorization: Bearer <access_token>` で X2 成功 |
| 追加ヘッダ | X2 成功時は chatgpt-account-id、originator、User-Agent、session-id、thread-id、x-client-request-id、Content-Type / Accept。OpenAI-Beta は付けていない。必要最小集合は未確定 |
| ボディ制約 | X2 は store: false、instructions: `You are a helpful assistant.` で成功。store の true / 省略は未試験 |
| 資格情報 | `~/.codex/auth.json` の `tokens.{access_token, refresh_token, id_token, account_id}` |
| 利用可能モデル | X5: `GET /models?client_version=0.159.2` が HTTP 200、10モデルの設定と ETag を返した。一覧への掲載と推論呼び出し成功は別に確認する |

変換: 内部 `tool_use` → `function_call` item、`tool_result` → `function_call_output` item。`store:false` の場合、推論は `include: ["reasoning.encrypted_content"]` で受け取り、次ターンで返送する。

ストリーム処理: `response.output_text.delta` / `response.output_item.done`(function_call 確定)/ `response.completed`(usage)を組み立てる。

X2 は Luna / Sol / Astra とも effort high で `pong` を返した。レスポンスに Content-Type がない場合もあり、SSE フレームを認識する。
X6 で x-codex-primary / secondary の used-percent、window-minutes、reset-at を取得。実測の window-minutes は300 / 10080。
X3 は Luna の function_call をそのまま履歴に戻し、同じ call_id の function_call_output を返して両方 HTTP 200。関数往復には reasoning item がなく、保存済み X4 の reasoning / encrypted_content と message を次ターンに返す別試験で HTTP 200 / pong を確認した。
X5 の設定では Luna / Sol / Astra の context_window は272000。上限までの入力試験はしていない。
X4 は Sol の low / medium / xhigh / max、Astra / Luna の low / max が HTTP 200 / pong。high は X2 で確認済み。
調査した CLI ソースは Ultra を通常リクエスト用 effort に変換し、X5 の Sol / Astra 設定では xhigh に解決する。ユーザー承認2026-10-01: Phase 1 は low / medium / high / xhigh / max とし、Ultra は自動委譲を含む設計まで保留。
X7 は CLI 起動とその後の直接疎通が成功。期限前でトークンは変化せず、実更新・期限切れエラーは未実測。認証エラー時は再試行を止め、公式 CLI に更新を委ねて資格情報を読み直す。根拠: [docs/phase0-findings.md](docs/phase0-findings.md)。

---

## 8. Agent Loop

> 各ステップの詳細な定義(入出力・失敗時の経路・状態遷移)は **§19 STEP 設計** を参照。本節は概要。

```
loop:
  1. Context Manager がトークン量を確認 → 閾値超えなら compact
  2. Router が今回使う provider/model を決定
  3. provider.stream() を UI に流しつつ assistant Message を確定
  4. stopReason == "tool_use" でなければ終了、ユーザー入力待ちへ
  5. 各 tool_use について:
       a. Permission Gate で allow / deny / ask
       b. 実行(読み取り系ツールは並列実行可、書き込み系は直列)
       c. 結果を tool_result にまとめる(長すぎる出力は切り詰め、先頭と末尾を残す)
  6. tool_result を user Message として追加 → 1へ
```

- **中断**: Ctrl+C で AbortSignal を発火。実行中の tool_use には `isError: true, "ユーザーにより中断"` を返して履歴の整合性を保つ(tool_use に対応する tool_result が欠けると次の呼び出しでエラーになるため)
- Phase 0 R2: Node.js 22 の fetch は両プロバイダで SSE 読み取り中の abort に `AbortError`。中断指示後にも受信済みイベントが届く場合がある。途中の item / 引数を確定・実行せず、完了イベントの有無と中断状態を確認する。実際の Ctrl+C キー操作と tool 実行中の中断は未検証。
- **上限**: 1ターンあたりの最大ステップ数(既定 100)

---

## 9. Permission Gate

```ts
type Decision = "allow" | "deny" | "ask";
interface Rule { tool: string; pattern?: string; decision: Decision }
```

- 既定値: Read/Grep/Glob は allow、Write/Edit/Bash/WebFetch は ask
- `ask` 時の選択肢: 今回のみ許可 / このセッション中許可 / 常に許可(設定に保存)/ 拒否(理由をモデルに返す)
- Bash はコマンド先頭トークン単位でルール化(例: `git status*` → allow)
- 作業ディレクトリ外への書き込みは常に ask

### 9.1 権限モード(セッションごとに切替)

| モード | 読み取り系 | Edit / Write | Bash・WebFetch | 用途 |
|---|---|---|---|---|
| `default` | allow | ask | ask | 既定。ルールで個別に allow を増やしていく |
| `acceptEdits` | allow | **allow**(ワークスペース内) | ask | 実装を任せたいとき |
| `plan` | allow | deny | 読み取り専用コマンドのみ allow | 調査・計画だけさせたいとき |

- **モードはセッションごとに持つ**。新しいセッションは設定の `permissions.mode`(既定 `default`)で始まる
- 切替方法: PromptLine 右下の `mode ▾` ボタン / `Shift+Tab` で順に切替 / `/mode acceptEdits`
- 切替は次のツール呼び出しから反映する。モードを変えたことは Receipt に残す
- セッションの worker・reviewer は親セッションのモードを引き継ぐ
- タスク段階の **plan 段階では、モードに関係なく書き込み系を使えない**(§20)
- どのモードでも変わらないもの: 個別ルールの deny、作業ディレクトリ外への書き込みは ask、秘密情報ファイルの読み取りは ask、危険なコマンドは ask
- Sidebar のセッション行と PromptLine に、今のモードを小さく表示する(`acceptEdits` は `--warn` 色)

---

## 10. サブエージェント (Task ツール)

混合型の主要な価値はここにある。

### 10.1 役割分担(確定)

| 役割 | 既定モデル | やること | 使えるツール |
|---|---|---|---|
| **main** | Claude Opus 5.5 · effort high | あなたと会話し、**計画を立て、自分で実装する**。必要に応じて explorer に調査を任せる | 全部(書き込み可) |
| **explorer** | Claude Sonnet 5.5 | コードベースの調査・検索。結果を要約して main に返す | Read, Grep, Glob, WebFetch |
| **worker** | **計画段階で main が項目ごとに決める**(§21) | 計画の1項目を実装する。並列実行できる項目は複数の worker が同時に動く | Read, Write, Edit, Bash, Grep, Glob(自分の worktree の中だけ) |
| **reviewer** | Codex(GPT) | 差分のレビュー。指摘を重要度付きで返す | Read, Grep, Glob, Bash(テスト実行用) |

- **計画は main(Claude)、実装は計画で割り当てたモデル、レビューは Codex**。別の会社のモデルにレビューさせることで、同じモデルの思い込みを見逃しにくくする。Codex が実装した部分は Claude がレビューする(§21.6)
- main のモデルは画面右下のモデルボタンからいつでも切り替えられる(§16.8)。reviewer など子エージェントのモデルは設定で変える
- 段階(計画 → 実装 → レビュー)の進め方は §20 を参照

### 10.2 Task ツール

```ts
Task({ description, prompt, agent: "explorer" | "reviewer" | string, model?: string })
```

- 子は**新しい Session**(親の履歴は引き継がず、prompt のみ)。最終テキストだけを親へ tool_result として返す
- reviewer は通常 main が直接呼ぶのではなく、**§20 のレビュー段階でハーネスが起動する**(main が「完了」と言っただけでレビューが飛ばされないようにするため)
- エージェント定義は設定ファイルで持つ:

```yaml
agents:
  explorer: { model: claude:sonnet, tools: [Read, Grep, Glob, WebFetch] }
  reviewer: { model: codex:sol, effort: high, tools: [Read, Grep, Glob, Bash] }   # Codex が書いた部分は claude:sonnet (§21.6)
```

- worker はハーネスが計画に従って起動する(§21)。main が Task で worker を直接起動することはしない
- 書き込みができるのは main と worker。worker は**それぞれ専用の worktree** で作業するので、同じファイルへの同時書き込みは起きない(統合はハーネスが行う。§21.4)

---

## 11. Router(モデル選択・フォールバック)

- 指定方法: `provider:model` 形式(例: `claude:opus`、`codex:sol`)。エイリアスとモデル一覧はモデルカタログ(§21.9)で定義
- **フォールバック**: `rate_limited` を受けたら
  1. `retryAfterSec` が短ければ(既定60秒以内)待って再試行
  2. 長ければ設定の `fallback` 先へ切り替え(ユーザーに通知)。履歴は内部形式なのでそのまま移行可能(reasoning は除外)
- **使用量記録**: レスポンスのレート制限系ヘッダがあれば記録し、`/usage` で表示。ヘッダ名は Phase 0 で調査

---

## 12. 設定

`~/.xharness/config.yaml`(グローバル)と `<project>/.xharness/config.yaml`(プロジェクト)をマージする。

```yaml
main:
  model: claude:opus          # 右下のモデルボタンで変更可(§16.8)
  effort: high                # low | medium | high | max
fallback:
  claude: codex:sol           # Claude の枠が切れたら main を Codex で継続
  codex: claude:sonnet        # Codex の枠が切れたら reviewer を Sonnet で代行
aliases:
  opus: claude-opus-5-5
  sonnet: claude-sonnet-5-5
  haiku: claude-haiku-4-5-20251001
  astra: gpt-6-astra
  sol: gpt-6.1-sol
  luna: gpt-6-luna
# モデルの一覧・特徴・effort は catalog (§21.9) で管理する
workflow: { ... }             # §20
hooks: [ ... ]                # §19.10
permissions:
  mode: default
  rules:
    - { tool: Bash, pattern: "git status*", decision: allow }
context:
  compactThreshold: 0.8      # コンテキスト窓の80%で圧縮
  memoryFiles: [AGENTS.md, CLAUDE.md]
agents: { ... }              # §10
```

セッション履歴は `~/.xharness/sessions/<id>.jsonl` に追記保存する(内部形式のまま)。これで `--resume` を実現する。

---

## 13. 実装フェーズ

> 実装担当は Codex(GPT-6.1 Sol)を想定。作業ルールは [AGENTS.md](AGENTS.md)、Phase 0 の詳しい手順は [docs/phase0-runbook.md](docs/phase0-runbook.md)、結果の記入先は [docs/phase0-findings.md](docs/phase0-findings.md)。

### Phase 0: 疎通検証（ゲート完了: 2026-10-01）
- [x] `claude login` 済み環境で資格情報ファイルの場所と構造を確認
- [x] Claude: OAuthトークンで Messages API のテキスト・tool 往復が成功。動作したヘッダと system 構成を記録（ヘッダ省略による最小集合は未試験）
- [x] Claude: 期限切れ時は公式 CLI に更新を委ねる方針を確定。CLI 起動・読み直し後の直接疎通を確認（実更新は未実測。自前 refresh の endpoint / client_id は調査対象にしない）
- [x] `codex login` 済み環境で `auth.json` の構造を確認
- [x] Codex: Responses API のテキスト・関数往復・推論 item 返送が成功。動作したヘッダ・instructions・モデルを記録
- [x] Codex: 公開ソースの refresh 方法を調査し、公式 CLI に更新を委ねる方針を確定。CLI 起動・読み直し後の直接疎通を確認（実更新は未実測）
- [x] 両方: Claude の自然な429を記録。Codex は自然な429がなくソースを根拠にした（未実測を明記）
- [x] 実レスポンス(SSE)を `test/fixtures/` に保存

完了条件は手順書の6項目に照合した。未実測・任意項目は調査記録に残し、実更新や Opus の疎通成功と混同しない。Phase 1 は未着手。

**成果物**: `spike/claude.ts`、`spike/codex.ts`、本書 §7 の表を確定値に更新

### Phase 1: 単一プロバイダの最小エージェント(UI なし)
- 内部形式、ClaudeAdapter、Agent Loop、Read/Write/Edit/Bash/Grep/Glob
- `headless.ts` で readline の REPL から動かす。権限は全部 ask で可

### Phase 2: Electron シェルと exe 化
- フレームレスウィンドウ、TitleBar、Transcript、PromptLine、PermissionDialog、テーマ(§16.2)
- Sidebar(セッション一覧・新規・再開)と WorkspacePicker の folder タブ(§16.6, §18)
- IPC イベント(§16.4)で core とつなぐ
- **この段階で一度 exe をビルドして別フォルダで起動確認**する(パッケージング由来の問題を早く潰すため)

### Phase 3: 混合化
- CodexAdapter、変換の単体テスト(fixtures 使用)、`/model` での途中切替、Router のフォールバック

### Phase 4: 実用化と可視化
- Permission ルール、Context 圧縮、プロジェクトメモリ、セッション保存と再開
- Receipts・UsagePopover・LoopFlow・StepTabs・Hero(§16.3, §16.7)
- WorkspacePicker の repository タブ、worktree による隔離(§18.2, §18.3)

### Phase 5: サブエージェントとタスク段階
- Task ツール、explorer / reviewer の定義、AgentsPanel
- タスク段階(§20)、PhaseBar、ModelPicker
- 計画項目の割り当てと worker の並列実行(§21)。最初は「並列数 1」で順番に動く形を作り、統合とレビューが安定してから並列数を上げる
- STEP フックの入り口とシェルコマンドフック(§19.10)
  - フックの入り口(`beforeStep` / `afterStep` の呼び出し)だけは Phase 1 の Agent Loop 実装時に入れておく

### Phase 6 以降(任意)
- MCP クライアント、フック、git worktree によるサブエージェント隔離、自動アップデート、レシートのリプレイ

---

## 14. リスクと対策

| リスク | 影響 | 対策 |
|---|---|---|
| 非公開エンドポイントの仕様変更 | 動作停止 | Adapter に隔離。fixtures による変換テストで差分を早期検知 |
| **トークンリフレッシュの競合** | 公式CLI側がログアウト状態になる | v1 は**自前 refresh を行わず、期限切れ・認証エラーで止め、公式CLIで更新後にファイルを読み直す**。更新が失敗する場合は再ログインを案内。方針確定2026-10-01。CLI 起動は確認済み、実更新は未実測 |
| 識別文やプロンプトの制約 | 自由なシステムプロンプトが使えない | 制約部分を Adapter が自動付与し、自前プロンプトは後続ブロックに置く |
| 枠の早期枯渇(サブエージェント多用時) | 作業停止 | プロンプトキャッシュの活用、サブエージェント並列数の上限、Router のフォールバック |
| Bash による破壊的操作 | データ損失 | Permission Gate、作業ディレクトリ外の書き込みは ask、`rm -rf` などの危険パターンは常に ask |
| 資格情報の漏洩 | アカウント被害 | トークンはログ・セッションファイル・レシートに書かない。エラー出力時はマスクする。**トークンをレンダラへ渡さない**(認証はメインプロセスで完結) |
| レンダラ経由の任意コード実行 | ローカル環境の乗っ取り | `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。preload は用途を限定した関数だけ公開。モデル出力の Markdown は必ずサニタイズして描画し、外部リンクは `shell.openExternal` で既定ブラウザへ |
| 未署名 exe の警告 | 初回起動時に SmartScreen 警告 | 個人利用なので許容(「詳細情報 → 実行」)。気になる場合はコード署名証明書を検討 |

---

## 15. 決定事項

**A〜D はすべて推奨案で決定(2026-10-01)**。E は Phase 0 で確定させる。

### A. 動作に大きく影響するもの
| # | 項目 | 決定 | 理由 |
|---|---|---|---|
| A1 | **git の扱い**: 誰がいつコミットするか | worker は自分の worktree で項目ごとに自動コミット。統合もハーネスが自動。**ユーザーの元ブランチへのマージと push は必ずユーザーが承認**。PR 作成は v2 | 元ブランチと外部への反映だけは取り返しがつきにくいため |
| A2 | worktree を既定で使うか | git 管理下なら**既定で ON** | 並列実行(§21)の前提。元の作業ツリーを汚さない |
| A3 | 計画の承認 | **毎回確認**(`planApproval: ask`) | 割り当てたモデルを確認・変更する機会になる。慣れたら auto にできる |
| A4 | 起動時の権限モード | `default`(読み取りは許可、書き込みとコマンドは確認) | 最初は安全側。プロジェクトごとにルールを育てる |
| A5 | 枠が残り少ないときの動き | 95% を超えたプロバイダには新しい worker を割り当てない。100% で fallback | 作業の途中で止まるのを避ける |
| A6 | 秘密情報ファイル(`.env` など)の読み取り | **常に確認**(ルールで allow にもできる) | モデルに送ると外部に出るため |

### B. 開発環境(別端末での実装前に決める)

**すべて無料で揃う**(オープンソースまたは無料配布)。費用がかかるのは Claude と ChatGPT のサブスクだけ。コード署名証明書は有料だが、個人利用なので使わない(§14)。

| 用途 | ツール | ライセンス |
|---|---|---|
| 実行環境 | Node.js 22 LTS | MIT |
| パッケージ管理 | pnpm | MIT |
| アプリ基盤・ビルド・パッケージ | Electron / electron-vite / electron-builder | MIT |
| UI | React / Zustand | MIT |
| Markdown・ハイライト | react-markdown / rehype-sanitize / Shiki | MIT |
| テスト・lint・整形 | Vitest / ESLint / Prettier | MIT |
| フォント | Silkscreen / JetBrains Mono | OFL(同梱・再配布可) |
| シェル・バージョン管理 | PowerShell 7 / Git for Windows | MIT / GPL |
| エディタ | VS Code(任意) | 無料 |
| アイコン変換 | sharp + png-to-ico(npm) | Apache-2.0 / MIT |

| # | 項目 | 決定 |
|---|---|---|
| B1 | Windows でのコマンド実行シェル | **PowerShell 7**(なければ 5.1)。Git Bash があれば設定で切替可 |
| B2 | パッケージマネージャ | pnpm |
| B3 | テスト・lint | Vitest、ESLint + Prettier |
| B4 | UI ライブラリ | React + Zustand + CSS Modules(UI 部品ライブラリは使わず、モックの CSS を移植) |
| B5 | Markdown 描画 | react-markdown + rehype-sanitize、コードは Shiki でハイライト |

### C. 見た目・使い勝手
| # | 項目 | 決定 |
|---|---|---|
| C1 | アプリ名とロゴ文字列 | **XHarness**(ロゴは §16.10) |
| C2 | UI の言語 | ラベルは英語(モックのまま)、メニュー・説明・確認文は日本語 |
| C3 | モデルの応答言語 | 日本語(システムプロンプトで指定。設定で変更可) |
| C4 | 画像入力 | v1 は貼り付け・ドラッグ&ドロップで画像を送れるようにする(両プロバイダとも対応) |

### D. 運用
| # | 項目 | 決定 |
|---|---|---|
| D1 | セッション・レシートの保存期間 | 無期限(アーカイブで一覧から隠す)。容量が 1GB を超えたら古いものの削除を提案 |
| D2 | 上限値(§19.5) | 表の既定値のまま始め、使いながら調整 |
| D3 | ログ・テレメトリ | 外部送信なし。ローカルのログだけ(トークンはマスク) |
| D4 | バックアップ | `~/.xharness/` を丸ごとコピーすれば移行できる構成にする(パスは相対で保存) |

### E. Phase 0 で確定させるもの(調べれば決まる)
- [x] Claude / Codex の OAuth 直叩きで成功する構成を記録(§7)。ヘッダ省略による必要最小集合は未試験
- [x] Codex の通常 effort と X5 掲載モデルの context_window を記録(§21.9)。上限までの入力は未試験
- [x] 使用量(5時間枠・週間枠)のヘッダ取得を確認(§16.7)
- [x] Codex のモデル一覧取得を確認(§21.9)。Claude は手動カタログを継続し、未確認の自動取得を実装しない

---

## 16. UI デザイン

参考: ダークなターミナル風UIで、エージェントの各ステップをフローチャートとログで「見える化」するスタイル。完成イメージは [mockup/index.html](mockup/index.html)。

### 16.1 コンセプト
- **ターミナルの見た目、アプリの操作性**: 全体を等幅フォントにし、`# コメント`、`❯` プロンプト、`1/6` のようなステップ番号でターミナルらしさを出す。一方で、パネル・バー・ダイアログなどの GUI 部品も使う
- **ループを隠さない**: 今どのモデルが何をしていて、どのツールが何を実行したかを常に見せる
- **色 = 役割**: 色はプロバイダや処理の種類を表すためだけに使い、装飾には使わない

### 16.2 デザイントークン

| トークン | 値 | 用途 |
|---|---|---|
| `--bg` | `#141518` | ウィンドウ背景 |
| `--panel` | `#1b1d21` | パネル・ノード背景 |
| `--panel-head` | `#22252b` | ノード見出し |
| `--line` | `#2c3037` | 枠線・区切り線 |
| `--text` | `#d4d7dd` | 本文 |
| `--dim` | `#6c727d` | 注釈・`#` コメント・ラベル |
| `--claude` | `#e2804f` | **Claude**(ロゴ・強調にも使うブランド色) |
| `--codex` | `#6b8fe0` | **GPT / Codex** |
| `--code` | `#62b07a` | **ハーネスのコード側**(Router・Gate・成功) |
| `--tool` | `#9a86d6` | **ツール実行** |
| `--warn` | `#d9a54a` | ask 待ち・フォールバック |
| `--err` | `#e06363` | 拒否・エラー |

- フォント: 見出しロゴは **Silkscreen**(ピクセル書体、オレンジに濃い影を付けて立体感を出す)、それ以外はすべて **JetBrains Mono**。どちらも OFL ライセンスなので `resources/fonts/` に同梱する
- 文字サイズ: 本文 13px、ラベル・注釈 11px。角丸は 4px まで、影は使わない(ロゴを除く)

### 16.3 画面構成

```
┌ TitleBar ─ ✕XHARNESS [📁 ~/dev/myapp ⎇ xh/a91f worktree ▾]  [◔ usage 84% ▾] claude● codex● ─□× ┐
├───────────────┬──────────────────────────────────────────────────────────────┤
│ Sidebar        │ Hero:  ✕HARNESS (ピクセルロゴ)             model · agents · steps · ● live │
│ [+ new session]│        Claude plans, GPT builds, code decides. ...                 │
│ [search      ] │ PhaseBar: [✓ 1 PLAN] → [● 2 IMPLEMENT] → [○ 3 REVIEW]               │
│                │ StepTabs: loop 7 · main [1/6 context][2/6 model] … [6/6 receipt]   │
│ sort: recent ▾ ├─────────────────────────────┬────────────────────────────────┤
│ ▾ myapp     ●4 │ Transcript                   │ LoopFlow                         │
│   ▌ログイン 12m │  発言・応答・ツール呼び出し     │  レーン名 / ノード / # 注釈         │
│    README …    │                              │  実行中ノードは枠を光が回る         │
│ ▾ client-site 2├─────────────────────────────┴──────────┬─────────────────────┤
│    依存更新 ask │ Receipts                                 │ AgentsPanel          │
│ ▸ cli-tool   2 ├──────────────────────────────────────────┴─────────────────────┤
│ ▾ その他      4 │ PermissionInline (必要なときだけ)                                  │
│ ⚙ settings     │ PromptLine:  ~/dev/myapp ❯ _          [● opus 5.5 · high ▾] [ask ▾] │
└───────────────┴──────────────────────────────────────────────────────────────┘
   ▲ WorkspacePicker と UsagePopover はタイトルバーのボタンから開くポップオーバー
```

- **Sidebar は折りたたみ可能**(`Ctrl+B`。幅は 252px、ドラッグで 200〜400px に変更可)
- **Hero は折りたたみ可能**にする(作業中は縦幅を節約したいため。`Ctrl+H` で切替、状態は設定に保存)
- **LoopFlow のノード**: `user · prompt` → `claude · plan` → `router · select` → `codex · tool_use` → `gate · permission` → `tool · act`(拒否時は `fallback` へ分岐)→ `receipt`。各ノードの見出し色は §16.2 の役割色に従い、ノード内に key/value を2〜3行表示する
- **Receipts**: 1行 = 1ステップ。`#id / provider / tool / decision / 所要時間 / トークン`。クリックで詳細(入力・出力の全文)を開く
- **PermissionDialog**: 画面中央のモーダルではなく、**PromptLine の直上にインラインで出す**(ターミナル的な操作感を保つため)。キー操作は `y` 許可 / `a` 常に許可 / `n` 拒否
- **実行中のステップを光らせる**: 今動いているステップ(StepTabs のタブと LoopFlow のノード)は、枠の周りを光が回るアニメーションで示す
  - 実装: CSS の `@property` で角度を定義し、`conic-gradient` の枠線を回転させる(1周 1.6 秒)。あわせて外側の `box-shadow` をゆっくり明滅させる(2.4 秒周期)
  - 色はそのステップの役割色(§16.2)。例: ツール実行中は `--tool`、Claude 応答中は `--claude`
  - 権限待ち(ask)の間は回転を止め、`--warn` 色の明滅だけにする(「動いている」のではなく「待っている」ことを区別するため)
  - OS の「アニメーションを減らす」設定(`prefers-reduced-motion`)が有効なら、アニメーションせず色付きの枠だけにする
  - 裏で動いているセッションは、Sidebar の行の `●` を同じ色で明滅させる
- **ウィンドウ幅が 1100px 未満**のときは LoopFlow を隠し、Transcript だけを表示する(タブで切替)

### 16.4 core → UI のイベント

レンダラは状態を持たず、メインから送られるイベントを Zustand ストアに反映するだけにする。

```ts
type UiEvent =
  | { type: "step"; step: 1 | 2 | 3 | 4 | 5 | 6; node: string }          // StepTabs / LoopFlow の強調
  | { type: "text_delta"; messageId: string; text: string }
  | { type: "tool_call"; receiptId: string; provider: string; tool: string; input: unknown }
  | { type: "permission_request"; requestId: string; tool: string; summary: string }
  | { type: "receipt"; receipt: Receipt }
  | { type: "usage"; provider: "claude" | "codex"; window5h?: number; weekly?: number }
  | { type: "agent"; agentId: string; name: string; model: string; status: "running" | "done" | "error" }
  | { type: "error"; message: string };
```

IPC チャネルは `harness:event`(main → renderer)と `harness:command`(renderer → main。送信・中断・権限応答・モデル切替)の2本だけにする。

### 16.5 Receipt(ステップ記録)

```ts
interface Receipt {
  id: string;                // "#0412" 形式で表示
  sessionId: string;
  ts: number;
  provider: "claude" | "codex" | "harness";
  model?: string;
  kind: "model_call" | "tool" | "permission" | "fallback" | "compact";
  tool?: string;
  decision?: "allow" | "deny" | "ask→allow" | "ask→deny";
  durationMs: number;
  usage?: Usage;
  summary: string;           // 1行要約(秘密情報はマスク)
}
```

`~/.xharness/receipts/<sessionId>.jsonl` に追記保存する。将来、同じレシート列を別の設定(モデル・権限ルール)で再実行して比較できるようにするため、ツール入力も保持する。

### 16.6 Sidebar(セッション履歴)

- 上から順に `+ new session`(`Ctrl+N`)、検索、並び順、セッション一覧、`⚙ settings`
- **一覧はワークスペースごとにグループ化**する(折りたたみ可能。開閉状態は保存する)
  - グループ見出し: ワークスペース名、セッション数、実行中・権限待ちがあれば色ドット。その下にパスと種別(`git` / `no git` / `cloned`)を小さく表示する
  - グループの並び順: 最後に使った順(既定)/ 名前順。実行中のセッションを含むグループは常に上にする
  - グループ内の並び順: 更新が新しい順
  - **ワークスペースを指定していないセッションは、末尾の「その他」グループ**にまとめる(§18.5)
  - 見出しの右クリック: このワークスペースで新規セッション / エクスプローラーで開く / 一覧から外す(セッションは消さない)
- 各行の表示: 1行目にタイトル。2行目に使ったプロバイダの色ドット、`⎇ ブランチ`、状態(`● 12m` 実行中 / `● ask` 権限待ち / `2h ago`)。ワークスペース名はグループ見出しにあるので行には出さない
- **タイトル**: 最初のユーザー発言から自動生成する(安いモデルで1回だけ要約)。ダブルクリックで名前を変更できる
- **右クリックメニュー**: 名前変更 / 複製(履歴をコピーして新しいセッションにする)/ ワークスペースをエクスプローラーで開く / アーカイブ / 削除(確認あり。worktree を使っていた場合は、片付けるかどうかも聞く)
- **権限待ちの通知**: 裏で動いているセッションが ask になったら、行を `--warn` 色にして Windows 通知も出す
- **複数セッションの同時実行**を許可する。ただし同じワークスペースで worktree を使わない書き込みセッションは1つまで(§18.3)

### 16.7 UsagePopover(使用量)

- 普段は**タイトルバー(ウィンドウ最上部のバー)の右側、接続状態ドットと最小化ボタンの左**に、ボタンを1つだけ表示する(`◔ usage 84% ▾`)。% は、全プロバイダの中で最も使用率が高い枠の値
- クリックまたは `Ctrl+U` でポップオーバーを開く。外側のクリックか `Esc` で閉じる
- 中身: プロバイダごとに 5時間ウィンドウと週間上限のバー、リセットまでの時間、フォールバックの設定内容。Claude は anthropic-ratelimit-unified-{5h,7d}-utilization / reset、Codex は x-codex-primary/secondary-used-percent / window-minutes / reset-at を使用（Phase 0 実測）。Claude の utilization は割合、Codex の used-percent は百分率として表示。ヘッダ欠損時は取得不可とし、0% と見なさない
- 色: 80% 以上は `--warn`、95% 以上は `--err`。アイコン横の % も同じ色にする
- 自動で開くことはしない。95% を超えたときだけ、トースト通知を一度出す

### 16.8 ModelPicker(main のモデル切替)

- 場所: **画面右下、PromptLine の右端**のボタン(`● opus 5.5 · high ▾`)。ドットの色はプロバイダ色
- クリックまたは `Ctrl+M` で、ボタンの上にポップオーバーを開く
  - claude: Opus 5.5(既定)/ Sonnet 5.5 / Haiku 4.5
  - codex: GPT-6 Astra / GPT-6.1 Sol / GPT-6 Luna(モデルカタログ §21.9 から生成。2026-10-01 時点)
  - effort: low / medium / **high**(既定)/ max
  - ボタン: `apply`(このセッションだけ変更)/ `既定にする`(設定ファイルの `main` を書き換える)
- 切り替えは**次の周の STEP 1 から**反映する(実行中の呼び出しは中断しない)。プロバイダをまたぐ場合は reasoning ブロックを除去する(§5)
- `/model opus high` のようにプロンプトから切り替えることもできる
- 枠切れで fallback が働いたときは、ボタンの表示も自動で切り替え、`↻ fallback` の印を付ける

### 16.9 PhaseBar(タスク段階)

- Hero の下、StepTabs の上に置く。`PLAN → IMPLEMENT → REVIEW` の3つ(§20)
- 各段階に、担当(`main · opus 5.5` / `reviewer · codex`)と進み具合(`承認済み · 3 項目` / `2 / 3 項目` / `round 0 / 2`)を表示する
- 状態: 完了は `✓` と `--code` 色、実行中は `●` で枠を光が回る(色は担当モデルの色)、未着手は `○` と `--dim` 色
- 雑談や質問だけのやり取りでは PhaseBar を出さない(§20.2)

### 16.10 ロゴとアイコン

- アプリ名: **XHarness**
- マーク: **Claude のオレンジ(`--claude`)と GPT のブルー(`--codex`)の2本のピクセルの線が交差する「X」**。2本が交わる中央の 2×2 マスは白く光らせ、「2つのモデルが交わるところで作業が生まれる」ことを表す。斜め下に濃い影を付け、ロゴの文字と同じ立体感を出す
- 各社のロゴマーク(Claude のマーク、OpenAI のマーク)は商標なので使わない・似せない。色だけをモチーフにする
- ファイル:
  - [brand/icon.svg](brand/icon.svg): アプリアイコン(512×512、角丸の暗い背景付き)
  - [brand/mark.svg](brand/mark.svg): 背景なしのマーク(タイトルバーやロゴの文字の横に使う)
- 使う場所: タイトルバー左上(マーク + `XHARNESS`)、Hero のロゴ(マーク + `HARNESS` のピクセル文字)、exe・タスクバー・インストーラのアイコン
- `icon.ico` の作り方: ビルド時のスクリプトで `icon.svg` を 16 / 24 / 32 / 48 / 64 / 128 / 256px の PNG に書き出し(sharp)、1つの `.ico` にまとめる(png-to-ico)。16px では線が細くなりすぎないよう、16・24px 用は影を省いた版を使う

---

## 17. exe 化(パッケージング)

### 17.1 方式の選定

| 方式 | 利点 | 欠点 | 判断 |
|---|---|---|---|
| **Electron** | core をそのまま Node で動かせる。Web技術でデザインを自由に再現できる。実績が多い(VS Code など) | exe が約 100MB と大きい | **採用** |
| Tauri | exe が小さい(約 10MB) | バックエンドが Rust。TS の core を動かすには Node サイドカーが必要で構成が複雑になる | 不採用 |
| Node SEA + TUI | 単一 exe でターミナル内で動く | フローチャートやパネル構成の再現が難しい | 不採用 |

### 17.2 構成
- ビルド: **electron-vite**(main / preload / renderer をまとめてビルド)
- パッケージ: **electron-builder**
  - `nsis`: インストーラ版(`XHarness-Setup-x.y.z.exe`、スタートメニュー登録あり)
  - `portable`: 単体 exe 版(`XHarness-x.y.z-portable.exe`、インストール不要)
- ウィンドウ: `frame: false` + `titleBarOverlay`(Windows 標準の最小化・最大化・閉じるボタンを残しつつ、タブバーは自前で描画)
- 背景色: `backgroundColor: "#141518"` を指定して、起動時の白いちらつきを防ぐ
- データの置き場所: 設定・セッション・レシートは `~/.xharness/` に置く(portable 版でも同じ場所)。資格情報は公式 CLI のファイルを読むだけで、アプリ側にはコピーしない

```yaml
# electron-builder.yml(抜粋)
appId: local.xharness.app
productName: XHarness
directories: { output: dist }
win:
  target: [nsis, portable]
  icon: resources/icon.ico
asarUnpack:
  - "**/node_modules/@vscode/ripgrep/**"   # Grep ツールで同梱 ripgrep を使う場合
```

### 17.3 注意点
- **ネイティブモジュール**を使う場合(例: `node-pty` で疑似端末を実現する)は、`electron-builder install-app-deps` で Electron 用に再ビルドが必要。v1 では `child_process.spawn` で足りるので使わない
- **作業フォルダの選択**: §18 の WorkspacePicker で行う。コマンドライン引数 `XHarness.exe C:\path\to\project` でも指定できるようにする。エクスプローラーの右クリックメニューに「XHarness で開く」を追加するかは任意(NSIS で登録可能)
- **シェルの PATH**: exe をエクスプローラーから起動すると、ターミナルから起動したときと環境変数が異なることがある。Bash ツールはユーザーの PATH を明示的に読み込んでから実行する
- **git が必要**: リポジトリ機能(§18)はシステムにインストールされた `git` を使う。起動時に `git --version` を確認し、見つからなければ、フォルダモードだけで動かすことを案内する

---

## 18. ワークスペース(フォルダ / リポジトリ)

Claude Code と同じく、**セッションは必ず1つのワークスペースに紐づく**。ツールの作業ディレクトリ、AGENTS.md / CLAUDE.md の読み込み、権限ルールの「作業ディレクトリ外」の判定は、すべてワークスペースを基準にする。

### 18.1 モデル

```ts
interface Workspace {
  id: string;                    // ルートパスのハッシュ
  root: string;                  // 絶対パス(Windows パスも正規化して保持)
  name: string;                  // 表示名(既定はフォルダ名)
  source:
    | { kind: "folder" }
    | { kind: "repo"; remoteUrl: string; clonedByHarness: boolean };
  git?: { branch: string; head: string; dirty: boolean };   // git 管理下のときだけ
  lastOpenedAt: number;
}

interface SessionWorkspace {
  workspaceId: string | null;    // null = 指定なし(「その他」§18.5)
  cwd: string;                   // 実際の作業ディレクトリ(worktree を使う場合は worktree のパス)
  worktree?: { path: string; branch: string; baseBranch: string };
  readOnly: boolean;             // true なら plan モードで開始
}
```

### 18.2 開き方(WorkspacePicker)

タイトルバーのワークスペースボタン、または `Ctrl+O` で開く。タブは2つ。

**folder タブ**
- 最近使ったワークスペースの一覧(git 管理下なら現在のブランチも表示)
- `open folder…` でネイティブのフォルダ選択ダイアログ(`dialog.showOpenDialog`)
- セッションのオプション: worktree で隔離する(git 管理下のときだけ有効)/ 読み取り専用で開く

**repository タブ**
- 入力欄: URL(HTTPS または SSH)、ブランチ、clone 先(既定は `~/.xharness/repos/<owner>/<repo>`)
- オプション: shallow clone(`--depth 1`)/ worktree で隔離する / 新しいブランチを作成
- 実行は `git clone` を子プロセスで呼ぶ。進捗は stderr を読んで表示する
- **認証はシステムの git に任せる**(Git Credential Manager や SSH エージェント)。ハーネスは GitHub のトークンなどを扱わない
- 同じ URL がすでに clone 済みなら、clone せずに `git fetch` して開く

### 18.3 worktree による隔離

- 有効にすると、セッション開始時に `git worktree add <path> -b xh/<sessionId短縮> <baseBranch>` を実行する
- worktree の置き場所: `~/.xharness/worktrees/<workspaceId>/<sessionId>`(元のリポジトリの中に作らないため、`.gitignore` の対応が不要)
- 利点: 元の作業ツリーを汚さない。同じリポジトリで複数のセッションを並行して実行できる。サブエージェントにも個別の worktree を割り当てられる(Phase 6)
- セッション終了時の選択肢: **残す**(既定)/ 元のブランチにマージ / ブランチを残して worktree だけ削除 / 両方削除
- 未コミットの変更がある worktree は、確認なしでは削除しない
- worktree を使わない場合、同じワークスペースで書き込みができるセッションは同時に1つまで。2つ目は読み取り専用で開くか、worktree を使うように案内する

### 18.4 セッションの保存と索引

```
~/.xharness/
├─ workspaces.json              # 最近使ったワークスペース
├─ sessions/
│  ├─ index.json                # 一覧表示用の索引(タイトル・ワークスペース・ブランチ・更新日時・状態・使ったプロバイダ)
│  └─ <sessionId>.jsonl         # 会話履歴(内部形式。§12)
├─ receipts/<sessionId>.jsonl   # §16.5
├─ repos/<owner>/<repo>/        # repository タブで clone したもの
└─ worktrees/<workspaceId>/<sessionId>/
```

- Sidebar は `index.json` だけを読む(起動を速くするため)。履歴本体はセッションを開いたときに読み込む
- 検索: v1 はタイトルと最初の発言の部分一致。全文検索は必要になってから追加する
- 再開: 履歴を読み込み、`SessionWorkspace.cwd` が存在するか確認してから続行する。worktree が消えていた場合は、ブランチから作り直すか確認する
- `index.json` の各セッションに `workspaceId`(指定なしは `null`)を持たせ、Sidebar はこれでグループ化する

### 18.5 ワークスペース指定なし(「その他」)

質問・調べもの・文章作成など、特定のフォルダを必要としない用途のためのセッション。

- `+ new session` でワークスペースを選ばずに開始すると、このモードになる
- 作業ディレクトリは `~/.xharness/scratch/<sessionId>/`(セッション専用の空フォルダ)にする。ツールがファイルを書く場合もここに閉じ込める
- 権限: スクラッチフォルダ内の Read/Write/Edit は allow、Bash は ask、スクラッチ外への書き込みは常に ask
- AGENTS.md / CLAUDE.md はグローバル(`~/.xharness/AGENTS.md`)だけを読み込む
- **あとからワークスペースに移せる**: セッションの右クリック →「ワークスペースへ移動…」。履歴はそのまま `workspaceId` と `cwd` を付け替え、スクラッチ内に作ったファイルはコピーするか確認する
- 削除時はスクラッチフォルダも一緒に消す(確認あり)

---

## 19. STEP 設計(ドラフト v0.1)

### 19.1 基本方針

参考にした投稿の考え方を取り入れる: **モデルは提案するだけ、決めるのはコード(とユーザー)。すべてのステップが記録を残す。**

- 6 つの STEP は**エージェントループの1周**を表す。1周 = 「モデルを1回呼び、出てきたツール呼び出しを処理して記録する」
- モデルが関わるのは STEP 2 だけ。残りの 5 つはハーネスのコードが決定的に処理する
- どの STEP も「成功」「やり直し」「別経路(fallback)」「停止」のどれかで必ず終わる。**宙ぶらりんの状態を作らない**
- 1周が終わるたびに Receipt が1件以上残る

### 19.2 STEP 一覧

| # | STEP | 担当 | やること | 出力 | 役割色 |
|---|---|---|---|---|---|
| 1 | **context** | code | 履歴・メモリファイル・ツール定義を組み立て、トークン量を確認する | `ProviderRequest` | `--dim` |
| 2 | **model** | Claude / GPT | Router がモデルを選んで呼び出し、応答をストリーミングで受け取る | assistant `Message` + `stopReason` | `--claude` / `--codex` |
| 3 | **tool_use** | code | ツール呼び出しを取り出し、スキーマ・前提条件を検証する | 検証済み `ToolCall[]` | `--code` |
| 4 | **gate** | code + user | 権限ルールで allow / deny / ask を決める。ask ならユーザーを待つ | 判定付き `ToolCall[]` | `--code`(ask 中は `--warn`) |
| 5 | **act** | code | 許可されたツールを実行する。実行直前に状態を再確認する | `tool_result[]` | `--tool` |
| 6 | **receipt** | code | 記録を書き、次に進むか止まるかを決める | `Receipt[]` + 次の遷移 | `--dim` |

### 19.3 状態遷移

```
            ┌────────────────────────────────────────────────┐
            ▼                                                │ tool_result あり
 [user] → 1 context ─→ 2 model ─→ 3 tool_use ─→ 4 gate ─→ 5 act ─→ 6 receipt
            │  ▲          │  │        │            │          │        │
   compact ─┘  │   429/障害 │  │ end_turn│ 検証NG      │ deny      │ 前提崩れ │ 完了/上限
               │          ▼  │        ▼            ▼          ▼        ▼
               │      fallback│   (エラーを tool_result にして 6 へ)      [idle]
               │      別モデル │
               └──────────────┘ stopReason ≠ tool_use → 6 receipt → [idle]
```

- **3・4・5 で失敗したツール呼び出しは、エラー内容を `tool_result(isError)` にしてモデルへ返す**。ループ自体は止めず、モデルに次の手を考えさせる
- ループを止めるのは: `end_turn`(モデルが完了と判断)/ ユーザーの中断 / 上限到達(§19.5)/ 回復できないエラー

### 19.4 各 STEP の詳細

#### STEP 1: context
- 入力: セッション履歴、システムプロンプト、AGENTS.md / CLAUDE.md、このエージェントで使えるツール定義
- 処理:
  1. トークン量を見積もる。コンテキスト窓の 80% を超えたら **compact**(古い部分を要約に置き換える)してから進む
  2. 前の周で次のプロバイダが決まっている場合(fallback 後など)は、他社向けに reasoning ブロックを除去する(§5)
  3. プロンプトキャッシュのブレークポイントを置く
- 失敗: compact しても収まらない → 停止してユーザーに知らせる

#### STEP 2: model
- 処理: Router(§11)がモデルを決め、Adapter で呼び出す。テキストはそのまま Transcript に流す
- 失敗時:
  | 状況 | 経路 |
  |---|---|
  | 429(枠切れ)で待ち時間が短い | 待ってやり直す(同じ STEP 2) |
  | 429 で待ち時間が長い | fallback 先のモデルへ切り替え → STEP 1 から(reasoning を除去するため) |
  | ネットワーク・5xx | 指数バックオフで 3 回までやり直す → それでも駄目なら停止 |
  | 認証エラー | トークン更新を1回試す(§14)→ 駄目なら停止して再ログインを案内 |
  | `max_tokens` で途中終了 | 「続けて」と送ってもう1周(1ターンにつき 2 回まで) |
  | `refusal` | 停止してユーザーに表示する |

#### STEP 3: tool_use(検証)
モデルが出したツール呼び出しを、**実行前にコードで検証**する。投稿の「filter」に当たる。

- スキーマ検証: 引数が JSON Schema に合っているか
- 利用可否: このエージェントに許可されたツールか(例: explorer は Write を使えない。main も plan 段階では書き込み系を使えない)
- 前提条件: ツールごとに定義する
  - Edit / Write(既存ファイル): このセッションで先に Read しているか
  - パス: ワークスペース(またはスクラッチ)の中か。外なら STEP 4 で必ず ask にする印を付ける
  - Bash: 空コマンドや明らかな危険パターン(`rm -rf /` など)に印を付ける
- 検証 NG: そのツール呼び出しは実行せず、理由を `tool_result(isError)` にする

#### STEP 4: gate(権限)
- §9 のルールで判定する。複数のツール呼び出しがあれば1件ずつ判定する
- ask の場合: PermissionInline(§16.3)を出してユーザーを待つ。待っている間、ループは止まる
- ask に**タイムアウトは設けない**(無人で勝手に進ませないため)。ただし Windows 通知は出す
- deny の場合: 理由(ユーザーが入力したものがあればそれ)を `tool_result(isError)` にする

#### STEP 5: act(実行)
- **実行直前の再確認**(投稿の「re-check」に当たる): STEP 3 から時間が経っている(ask 待ちなど)ことがあるため
  - Edit: 対象ファイルが最後に Read したときから変わっていないか(更新日時とハッシュで確認)。変わっていたら実行せず「ファイルが変更されています。もう一度 Read してください」と返す
  - worktree / cwd がまだ存在するか
- 並列実行: 読み取り系(Read / Grep / Glob / WebFetch)は並列、書き込み系(Write / Edit / Bash)は順番に実行する
- タイムアウト: Bash は既定 2 分(ツール引数で最大 10 分まで)。超えたらプロセスを止めてエラーを返す
- 出力の切り詰め: 30,000 文字を超えたら先頭と末尾を残して中略する
- Task(サブエージェント): 子エージェントのループを起動し、終わるまでこの STEP に留まる(§19.6)

#### STEP 6: receipt(記録と次の判断)
- この周の Receipt を書く(§16.5)。1周で、モデル呼び出し1件 + ツール呼び出しの件数分
- 次の遷移を決める:
  - tool_result があり、上限に達していない → STEP 1 へ
  - `end_turn` → idle(ユーザー入力待ち)
  - 上限到達 → idle にして理由を表示する
- 使用量(UsagePopover)とセッション索引(§18.4)をここで更新する

### 19.5 上限と安全装置

| 項目 | 既定値 | 到達時 |
|---|---|---|
| 1ターンあたりの周回数 | 100 | 停止して「続けますか?」と確認 |
| 同じツール・同じ引数の連続呼び出し | 3 回 | 4 回目は実行せず、ループしている旨をモデルに返す |
| 連続エラー(STEP 3〜5) | 5 回 | 停止してユーザーに知らせる |
| サブエージェントの入れ子の深さ | 1(子は Task を使えない) | Task を検証 NG にする |

### 19.6 サブエージェントと STEP の関係

- サブエージェントも**同じ 6 STEP のループ**で動く。STEP の定義は共通
- 親が STEP 5 で Task を実行している間、子は自分の STEP 1〜6 を回る
- 画面: StepTabs と LoopFlow は「今見ているエージェント」の STEP を表示する。AgentsPanel でエージェントを選ぶと切り替わる。既定は「いちばん最近動いたエージェント」に自動で追従する
- 子が ask になったら、親ではなく子の STEP 4 が光る(`--warn`)

### 19.7 UI への反映

- STEP に入るたびに `{ type: "step", step, node }` イベントを送る(§16.4)
- 1周に複数のツール呼び出しがある場合、StepTabs は `5/6 act (2/3)` のように何件目かも表示する
- 周回数は Hero の `steps` に表示する。StepTabs の上に小さく `loop 7` のように何周目かを出してもよい

### 19.8 STEP の実装形

```ts
type StepName = "context" | "model" | "tool_use" | "gate" | "act" | "receipt";

type StepOutcome =
  | { kind: "next"; to: StepName }           // 通常の遷移
  | { kind: "retry"; afterMs: number }       // 同じ STEP をやり直す
  | { kind: "fallback"; to: StepName; reason: string }
  | { kind: "stop"; reason: StopCause };     // idle へ

interface Step {
  name: StepName;
  run(ctx: LoopContext, signal: AbortSignal): Promise<StepOutcome>;
}
```

- Agent Loop は「今の STEP を実行 → 戻り値に従って次へ」を繰り返すだけの小さな状態機械にする
- 各 STEP は単体でテストできる(`LoopContext` を偽物にして入れる)
- STEP の前後にユーザー定義の処理を差し込める(§19.10)

### 19.9 未決事項
- [ ] 上限値(§19.5)の既定値

### 19.10 STEP フック(追加用の入り口)

6 つの STEP 自体は固定にし、**STEP の前後に処理を差し込む入り口(フック)**を用意する。v1 で作るのは入り口と、シェルコマンドを実行する最小限の機能まで。

```ts
type HookTiming = "before" | "after";

interface StepHook {
  id: string;
  step: StepName;                 // どの STEP の
  timing: HookTiming;             // 前か後か
  when?: HookCondition;           // 条件(下記)
  run(ctx: HookContext): Promise<HookResult>;
}

interface HookCondition {
  tools?: string[];               // 例: ["Edit", "Write"] のときだけ
  agents?: string[];              // 例: ["main"]
  phases?: PhaseName[];           // 例: ["implement"]
  pathGlob?: string;              // 例: "src/**/*.ts" を触ったときだけ
}

type HookResult =
  | { kind: "continue" }                                  // 何もしない
  | { kind: "inject"; message: string }                   // モデルへの追加情報として tool_result に付け足す
  | { kind: "block"; reason: string }                     // その操作を止める(before のみ)
  | { kind: "stop"; reason: string };                     // ループを止める
```

- **フックを実行できる場所**: どの STEP の before / after でもよい。よく使う例:
  | 例 | 位置 | 結果 |
  |---|---|---|
  | ファイル編集のたびに lint を走らせ、エラーをモデルに伝える | `after: act`(tools: Edit, Write) | `inject` |
  | 特定のフォルダ(例: `migrations/`)の書き換えを禁止する | `before: act` | `block` |
  | 秘密情報らしき文字列を含むコマンドを止める | `before: gate` | `block` |
  | モデル呼び出しのたびにシステムプロンプトへ今日の日付を足す | `before: model` | `inject` |
  | 実装段階が終わるとき、テストが通っていなければ先に進ませない | `after: receipt`(phases: implement) | `inject` |
- **設定ファイルでの書き方**(v1 はシェルコマンドのみ。コマンドの終了コードと標準出力で結果を決める):

```yaml
hooks:
  - id: lint-on-edit
    step: act
    timing: after
    when: { tools: [Edit, Write], pathGlob: "src/**/*.{ts,tsx}" }
    command: "npx eslint {{files}}"
    onFailure: inject          # 終了コード ≠ 0 なら出力をモデルに渡す
    timeoutSec: 60
  - id: protect-migrations
    step: act
    timing: before
    when: { tools: [Edit, Write], pathGlob: "migrations/**" }
    onMatch: block
    reason: "migrations/ は手で編集してください"
```

- フックの実行結果も Receipt に残す(provider は `hook`)。Receipts パネルに `hook  after:act → eslint  ok` のように表示する
- 安全のため、**プロジェクトの設定ファイル(`<project>/.xharness/config.yaml`)に書かれたフックは、初回に一覧を見せて承認を求める**(clone したリポジトリに仕込まれたコマンドを勝手に実行しないため)
- 将来の拡張: TypeScript のプラグインとしてフックを書けるようにする、STEP 自体を追加できるようにする(どちらも v2 以降)

---

## 20. タスク段階(計画 → 実装 → レビュー)

### 20.1 考え方

- 6 STEP が「ループの1周」という細かい単位なのに対し、段階は「1つの依頼をどこまで進めたか」という大きな単位
- **段階の切り替えはハーネスのコードが決める**(モデルが「終わりました」と言っただけでは次に進まない)。STEP 設計と同じ「決めるのはコード」の方針

| 段階 | 担当 | やること | 終了条件(コードが判定) |
|---|---|---|---|
| **1 plan** | main(Claude) | 調査して計画を立てる。書き込み系ツールは使えない | main が `SubmitPlan` ツールで計画を提出し、ユーザーが承認する |
| **2 implement** | 項目ごとに割り当てたモデル(main / worker)。並列可能な項目は同時に実行 | 計画どおりに実装し、統合後にテストを回す(§21) | 全項目が完了・統合済みで、main が `RequestReview` を呼ぶ。変更が1つ以上ある |
| **3 review** | reviewer(Codex) | 差分をレビューして指摘を返す | 指摘が「修正必須」なし → 完了。修正必須あり → 2 implement に戻る |

### 20.2 段階を使うかどうか

```yaml
workflow:
  mode: auto          # auto | always | off
  planApproval: ask   # ask | auto(計画を自動承認する)
  reviewRounds: 2     # レビュー → 修正の往復の上限
```

- `auto`(既定): main の最初の応答で、ファイル変更を伴う依頼かを判定する。変更を伴うなら段階を開始し、質問や雑談なら段階を使わない
- `always`: 常に段階を使う / `off`: 使わない(従来どおり main が自由に進める)
- 小さな修正(1ファイル・数行程度)なら、main が `SkipPlan` で計画段階を省略できる。ただしレビューは省略しない

### 20.3 段階専用のツール

| ツール | 使える段階 | 内容 |
|---|---|---|
| `SubmitPlan({ items: PlanItem[], notes })` | plan | 計画を提出する。各項目に担当モデル・依存関係・触るファイルを含める(§21.2)。承認されると implement へ |
| `UpdatePlan({ itemIndex, status })` | implement | 項目の進み具合を更新する(`2 / 3 項目`) |
| `RequestReview({ summary })` | implement | 実装完了を申告する。ハーネスが差分を集めて reviewer を起動する |
| `SkipPlan({ reason })` | plan | 計画を省略して implement へ |

### 20.4 レビュー段階の流れ

1. ハーネスが差分を集める(worktree なら `git diff <base>...HEAD` と未コミット分、そうでなければセッション中に Edit / Write したファイルの変更)
2. reviewer(Codex)を起動し、差分・計画・main の summary を渡す
3. reviewer は指摘を決まった形式で返す:
   ```ts
   interface ReviewFinding { severity: "must" | "should" | "nit"; file: string; line?: number; message: string }
   ```
4. `must` が0件 → 完了。PhaseBar をすべて `✓` にする
5. `must` がある → 指摘を main に渡して implement に戻す(round を +1)
6. round が上限(既定 2)に達しても `must` が残る場合 → 止めて、ユーザーに判断を求める
- `should` / `nit` は完了時にまとめて表示する(main は直さない。ユーザーが指示すれば直す)
- Codex の枠が切れているときは、fallback の `claude:sonnet` がレビューを代行する。PhaseBar に `↻ fallback` と表示する

### 20.5 ユーザーの操作

- PhaseBar の各段階をクリックすると、その段階の Transcript の位置へ移動する
- 計画の承認は PermissionInline と同じ場所に出す(`y` 承認 / `e` 修正を指示 / `n` 却下)
- いつでも `/phase implement` などで段階を手動で進めたり戻したりできる
- レビューだけをやり直す: `/review`

---

## 21. 実装の割り当てと並列実行

### 21.1 流れ

```
plan 段階 (main)
  └─ 項目に分解 → 依存関係と触るファイルを洗い出す → 項目ごとに担当モデルを決める → SubmitPlan
        │
        ▼ ハーネスが検証(§21.3)→ ユーザーが承認(担当の変更も可)
implement 段階 (ハーネスのスケジューラ)
  wave 1:  [P1 · sonnet] [P2 · codex]        ← 依存のない項目を並列に
              │ worktree w1   │ worktree w2
              └──────┬────────┘
                     ▼ 統合(セッションのブランチへマージ)→ テスト
  wave 2:  [P3 · main/opus] [P4 · haiku]
                     ▼ 統合 → テスト
review 段階 (reviewer)
```

- **割り当ては main が計画段階で判断し、実行はハーネスのコードが行う**。main は「誰に何をさせるか」を決めるだけで、worker の起動・待ち合わせ・統合はスケジューラの仕事
- **並列にできるかどうかもコードが最終判定する**。main が並列にできると言っても、触るファイルが重なっていれば順番に実行する

### 21.2 計画項目の形式

```ts
interface PlanItem {
  id: string;                      // "P1"
  title: string;
  instructions: string;            // worker に渡す具体的な指示(worker は main の履歴を持たないため、必要な情報をすべて含める)
  files: string[];                 // 触る予定のファイル(glob 可)
  dependsOn: string[];             // 先に終わっている必要がある項目
  assignee: {
    agent: "main" | "worker";
    model: string;                 // "claude:sonnet" / "codex:sol" など(カタログの enabled なモデルのみ)
    effort: "low" | "medium" | "high" | "max";
    reason: string;                // なぜこのモデルにしたか(1行)
  };
  acceptance: string;              // 完了の条件(例: "validateEmail の単体テストが通る")
}
```

### 21.3 担当モデルの決め方

main のシステムプロンプトに次の指針を入れ、項目ごとに判断させる。

| 項目の性質 | 推奨 | 理由 |
|---|---|---|
| 設計判断が多い・複数ファイルにまたがる・既存コードの理解が深く必要 | **main 自身**(Opus 5.5 · high) | 計画の意図を一番わかっている。worker に渡すと説明が長くなる |
| 範囲がはっきりした中規模の実装 | **claude:sonnet** · medium | 速さと品質のバランス |
| 型定義・単純なテスト追加・定型的な書き換え | **claude:haiku** · low | 速く、枠の消費が少ない |
| アルゴリズム・独立したユーティリティ・CLI/スクリプト | **codex:sol**(GPT-6.1 Sol)· high | Claude の枠を節約しつつ、別の視点で書かせる |
| 最も難しい項目で、Claude と別の視点が欲しいとき | **codex:astra**(GPT-6 Astra) | 枠の消費が大きいので、ここぞという項目だけ |
| 範囲の狭い大量の定型作業 | **codex:luna**(GPT-6 Luna) | Haiku と同じ位置づけ。Claude の枠を使いたくないとき |

> この表は指針の概要。**実際の判断材料はモデルカタログ(§21.9)から main に渡す**。モデルの得意・不得意をモデル自身の記憶に頼らないため。

ハーネスは提出された計画を次の観点で**検証し、問題があれば main に差し戻す**:
- 依存関係に循環がない
- カタログで `enabled: true` のモデルだけを指定している(提供終了したモデルや未確認のモデルは差し戻す)
- 指定した effort がそのモデルで使える(例: Luna は High 以上のみ)
- 並列にする項目どうしで `files` が重なっていない(重なっていたら、その2つを依存関係で直列にするよう指摘する)
- **使用量**: 割り当てたプロバイダの5時間枠が 90% を超えている場合は、別のプロバイダへの変更を提案する

ユーザーは承認時に、項目ごとの担当モデルを変更できる(計画の表示の中でクリックして選ぶ)。

### 21.4 スケジューラ

- 依存がすべて完了した項目から順に起動する(この単位を **wave** と呼んで画面に出す)
- **同時に動かす worker の上限: 3**(設定で変更可)。プロバイダごとの上限も設ける(例: codex は同時に 2 まで)
- main が担当する項目は、main 自身が実行する(worker は起動しない)。その間も他の worker は並行して動く
- **worktree**: worker ごとに、セッションのブランチから `xh/<session>-w<n>` ブランチと worktree を作る
- **統合**: worker が完了したら、ハーネスがセッションのブランチへマージする
  - 衝突しなければそのまま次へ
  - 衝突したら、main に「衝突の解消」という作業を渡す(main は両方の意図を知っているため)
- wave の全項目が統合されたら、テスト用のフック(§19.10、例: `npm test`)を1回走らせる。失敗したら main に原因調査を任せる
- **git がないワークスペースや worktree を使わない設定のとき**は、並列実行を無効にし、項目を1つずつ順番に実行する(同じフォルダを複数の worker が同時に書き換えるのを避けるため)

### 21.5 worker の振る舞い

- 受け取るもの: `instructions`、`files`、`acceptance`、関係するファイルの一覧。main の会話履歴は渡さない
- 6 STEP のループで動く(§19)。Task(サブエージェント起動)は使えない
- 書き込めるのは自分の worktree の中だけ。計画の `files` 以外のファイルを書き換えようとした場合、STEP 3 で検証 NG にはしないが、ask にしてユーザーに確認する
- 終了時に `ReportDone({ summary, changedFiles, testsRun })` を呼ぶ。ハーネスはこれを受けて統合する
- 失敗(上限到達・連続エラー)した場合は main に戻し、main が「担当を変えてやり直す / 自分でやる / ユーザーに聞く」を判断する

### 21.6 レビューとの関係

- レビューは統合後の差分全体に対して行う(§20.4)
- **実装したモデルと別のプロバイダがレビューする**:
  - Claude(main / sonnet / haiku)が書いた部分 → Codex(既定は GPT-6.1 Sol)がレビュー
  - Codex が書いた部分 → Claude Sonnet 5.5 がレビュー
  - 両方が含まれる場合は、2つのレビューを並列に走らせ、結果をまとめる
- `must` の指摘があった場合、main がどの担当に直させるか(元の worker のモデル / main 自身)を決め、implement に戻る

### 21.7 権限確認と通知

- 複数の worker が同時に ask を出すことがある。PermissionInline は**待ち行列**にして1件ずつ表示し、`w1 · sonnet wants to run …` のように誰の要求かを出す。`2 more` のように残り件数も出す
- ある worker が ask で止まっていても、他の worker は動き続ける

### 21.8 UI

- Transcript: main の計画に、項目・担当・依存・wave を表にして表示する。implement 中は worker ごとのカード(担当モデルの色ドット、ブランチ、今の STEP)を並べる
- PhaseBar の implement 段階: `wave 1 / 2 · 2 並列` と `完了項目 / 全項目` を表示する
- AgentsPanel: main・worker・reviewer を一覧にし、選んだエージェントの STEP を StepTabs と LoopFlow に表示する。未起動の worker は `wave 2` のように待ち状態を出す
- 動いている worker が複数あるときは、Sidebar のセッション行に `● 2` のように並列数を出す

### 21.9 モデルカタログ

**モデルの知識はモデルの記憶ではなく、ハーネスが持つ。** Claude も GPT も学習時点より後に出たモデルを知らず、サブスクで使えるモデルはプランや時期で変わるため。

- ファイル: `~/.xharness/models.yaml`。初期値の下書きは [catalog/models.yaml](catalog/models.yaml)(2026-10-01 時点の公式ドキュメントをもとに作成)
- 各モデルの項目: ID、短い名前、得意・不得意、担当できる役割、使える effort、既定の effort、枠の消費の重さ、提供終了日、実績
- **main への渡し方**: 計画段階のシステムプロンプトに、`enabled: true` のモデルだけを表にして入れる。使用量(§16.7)も一緒に渡し、枠が残り少ないプロバイダを避けられるようにする
- **モデル切替(§16.8)の選択肢もカタログから作る**

#### 鮮度を保つ仕組み

| 仕組み | タイミング | 内容 |
|---|---|---|
| 提供終了日 | 起動時 | `retiresAt` を過ぎたモデルを自動で `enabled: false` にし、通知する。設定や計画でそのモデルを指定していたら、代わりのモデルを提案する |
| 疎通確認 | 新しいモデルを追加したとき | 最小リクエストを1回送り、成功したら `verified: true` にする。失敗したら有効化しない |
| 一覧の取得 | 起動時(1日1回) | 各プロバイダからモデル一覧を取得し、カタログとの差分(新しいモデル・消えたモデル)を通知する。Codex は Phase 0 X5 で `GET /models?client_version=<version>` と ETag を確認。Claude の取得手段は未確認 |
| 手動更新 | 随時 | 設定画面から編集、または `/models refresh` で公式ドキュメントを確認して更新案を出す |

#### 実績による補正

レシート(§16.5)とレビュー結果(§20.4)から、モデルごと・作業の種類ごとに集計してカタログの `stats` に書き込む。

```yaml
stats:
  items: 42                 # 担当した計画項目の数
  successRate: 0.93         # 失敗して main に戻されずに完了した割合
  mustFindingsPerItem: 0.4  # レビューで修正必須の指摘を受けた件数の平均
  medianMinutes: 3.2
  byKind: { test: { items: 12, successRate: 1.0 }, refactor: { ... } }
```

- 計画段階では、この実績も main に渡す(例: 「haiku はテスト追加の成功率 100%、リファクタリングは 60%」)
- 集計は直近 90 日分だけを使う(モデルの更新で傾向が変わるため)
