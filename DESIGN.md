# XHarness 設計書 (v0.1)

Claude (Pro/Max) と GPT (ChatGPT Plus/Pro) のサブスク枠を直接利用する、Claude Code ライクな汎用エージェントハーネス。

- 言語: TypeScript (Node.js 24 LTSを基準、Node 22.20以降も互換確認)
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
- MCPクライアント(v1 の範囲外としていたが、Phase 6 で実装する。§25)
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
│  │  │  ├─ AgentsPanel.tsx # サブエージェント切替バー(Hero の overview 行の右側。§16.3)
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
  reasoning?: { effort: "low" | "medium" | "high" | "xhigh" | "max" };
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
| system 制約 | 第1ブロックに `You are Claude Code, Anthropic's official CLI for Claude.` を常に置き、自前指示は第2ブロック以降に置く（Phase 1 指示）。Adapter から Haiku / Opus 5.5 / Sonnet 5.5 の識別文 + 自前指示で HTTP 200 / end_turn を確認 |
| 資格情報 | `~/.claude/.credentials.json` の `claudeAiOauth.{accessToken, refreshToken, expiresAt}`(Windows/Linux。macOSはキーチェーン) |
| プロンプトキャッシュ | system と tools 末尾、直近メッセージに `cache_control` を付与(枠節約に効く) |
| effort / thinking | Opus/Sonnet 5.5 は `output_config.effort` を明示し既定 high（low/medium/high/xhigh/max）。Haiku は送らない。thinking は省略してネイティブ動作を維持し、tool_choice は auto のみ。履歴は追記し、同一プロバイダの thinking/signature は変更せず返す |

ストリーム処理: `content_block_start` / `content_block_delta`(`text_delta`, `input_json_delta`, `thinking_delta`)/ `content_block_stop` / `message_delta`(stop_reason, usage)を組み立てる。

C2 の実測: Haiku は `pong` / `end_turn`。Opus 5.5 は識別文ありで HTTP 200 / `pong` / `end_turn`、system なしは成功後の再確認も含め3回 HTTP 429。成功した識別文ありの構成を採用するが、429の原因は未確定。
使用量ヘッダとして `anthropic-ratelimit-unified-{5h,7d}-utilization` と `-reset` を確認。
Phase 1: SSE は Content-Type で判定せず、CRLF を含む行区切りで読む。429 の待ち時間は代表枠の `anthropic-ratelimit-unified-*-reset`（Unix 秒）から算出する。reset 自体が欠ける実レスポンスでは待ち時間を未定義にし、推測して自動再送しない。
Phase 1 の補正: Opus/Sonnet 5.5 に `output_config.effort: high`、thinking 省略、`tool_choice: auto` を各1回送り、両方 HTTP 200 / pong / end_turn。low/medium/xhigh/max は [公式 effort 仕様](https://platform.claude.com/docs/en/build-with-claude/effort) に基づき登録し、実通信は high のみ。履歴と thinking/signature を変えない追記・返送は変換とループのテストで確認。
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

- 既定値: 作業フォルダ内の Read/Grep/Glob は allow、Write/Edit/Bash/WebFetch は ask
- `ask` 時の選択肢: 今回のみ許可 / このセッション中許可 / 常に許可(設定に保存)/ 拒否(理由をモデルに返す)
- 評価順は Claude Code と同じ **deny → ask → allow**。ルールの細かさで順序は変えない(2026-10-02 ユーザー承認で Claude Code の仕様に合わせた)
- Bash(PowerShell)のルール:
  - 「常に許可」はサブコマンドまで含めて保存する(`git status` → `git status *`。`git *` にはしない)。先頭の語の次がオプション・パスなら完全一致で保存する
  - 連結(`;` `|` `&` `&&` `||`)・リダイレクト(`>` `<`)・改行・変数や式の展開(`$` `` ` ``)・部分式やスクリプトブロック(`(` `)` `{` `}` `@(`)・ドットソースを含むコマンドは、allow ルールやモードでは許可せず、必ず確認する(plan では拒否)。PowerShell では `git status (Remove-Item …)` の括弧の中も実行されるため
  - 別のプログラムを起動させうるオプション(`git -c` / `-C` / `--upload-pack` / `--ext-diff`、`rg --pre` など)を含むコマンドも同じ扱い
  - Git の status / diff / log / show も、読み取りに見えても必ず ask（plan・allow ルールでも自動承認しない）。`core.fsmonitor`、external diff、textconv、pager などリポジトリ設定による外部実行を字句解析だけでは保証できないため。危険なオプションは上記の拒否条件を維持する。アプリ内部の Git は pager と fsmonitor を無効化する（外部 diff / textconv を使う操作は内部にない）。
  - deny / ask ルールは、連結や括弧の中の部分コマンドに一致しても効く
- 作業フォルダ外への書き込みは常に ask。作業フォルダ外の Read/Grep/Glob も、それを許可するルールが無ければ ask(Claude Code の working directories と同じ)
- 秘密ファイル(`.env*`、鍵・証明書 `*.pem` `*.key` `id_*`、`.npmrc` `.netrc` `.git-credentials`、`.ssh/` `.aws/` `.kube/config` など)の読み取りは、ルールに関係なく ask(§A6)
- **保護パス**(Claude Code の protected paths に準拠): 作業フォルダ内の `.git/` `.xharness/` `.claude/` `.vscode/` `.idea/` `.husky/` など、`.gitmodules` やシェル・パッケージマネージャの設定ファイルへの書き込みは、acceptEdits や allow ルールでも自動承認せず ask
- **ワークスペースの信頼**(Claude Code の workspace trust に準拠): プロジェクトの `.xharness/config.yaml` は リポジトリから来るため、権限を広げる項目(allow ルールと `mode: acceptEdits`)は、ユーザーがそのワークスペースを信頼するまで適用しない。該当する項目があるとき、最初のターンの前に内容を見せて確認する(常に=記録して以後は尋ねない / 許可=このセッションだけ / 拒否=広げる項目を除いて続ける)。deny / ask と、権限を狭めるモード(plan / default)は信頼に関係なく適用する。信頼は `~/.xharness/trusted-workspaces.json` にフォルダの実体パスで記録する
- 「常に許可」のルールは、ワークスペースのセッションなら `~/.xharness/projects/<フォルダの鍵>/permissions.yaml`(そのワークスペースだけに効く。リポジトリの外なので、リポジトリの内容からは書き換えられない)へ、ワークスペース指定なしなら `~/.xharness/config.yaml` へ保存する
- WebSearch / WebFetch は §22 の外部通信ツールとして ask。Phase 3 では既存の全ツール ask を維持する。承認前に検索 API や取得先へ送信しない。
- WebFetch のネットワーク拒否条件は権限の許可では解除できない。ドメイン許可は `tool: WebFetch, pattern: domain:example.com` と保存し、サブドメインや別ホストへ拡張しない。キャッシュ参照も同じ gate を通す。

### 9.1 権限モード(セッションごとに切替)

| モード | 読み取り系 | Edit / Write | Bash・WebFetch | 用途 |
|---|---|---|---|---|
| 通常（保存値 `default`） | allow | ask | ask | 既定。ルールで個別に allow を増やしていく |
| 自動（保存値 `acceptEdits`） | allow | allow | allow（実行確認を自動許可） | ツール実行を任せたいとき |
| 計画（保存値 `plan`） | allow | deny | 読み取り専用コマンドのみ allow | 調査・計画だけさせたいとき |

- **モードはセッションごとに持つ**。新しいセッションは設定の `permissions.mode`(既定 `default`)で始まる
- 切替方法: PromptLine 右下の `mode ▾` ボタン / `Shift+Tab` で順に切替 / `/mode 通常|自動|計画`（英語名default・auto・plan、旧acceptEditsも利用可）
- 2026-10-04ユーザー承認: 画面のacceptEditsを「自動」に改名し、この選択を通常のツール実行のユーザー許可として扱う。内部の設定・保存値はacceptEditsを維持し、過去のセッションでも自動として動作する。ask判定とworkflowの確認必須指定も実行確認を省略するが、deny判定、セッションのplan/readOnly、ツール自身のネットワーク・ファイル拒否条件は解除しない。ワークスペースの信頼、プロジェクトフックの承認、MCP接続・プロンプト取り込み、公式CLIの認証は別の承認として維持する。子のreadOnly指定も自動許可の対象外。defaultの動作は従来どおり。
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
Task({ description, prompt, agent: "explorer" | "reviewer" | string, model?: string, background?: boolean })
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

### 10.3 バックグラウンドの子エージェント（2026-10-02、ユーザー承認）

- `background: true` は待たずに `taskId` を返す。対象は既存の Task と同じ調査・レビュー用の子。worker の割り当て・統合は引き続き §21 が管理する。
- main は `TaskList({})` で一覧、`TaskOutput({taskId, wait?, timeoutSec?})` で状態・最終結果、`TaskStop({taskId})` で個別停止を行う。待機は既定30秒、最大60秒。タイムアウト時は現在の状態を返す。
- 同時実行3件、親の1ターンにつき作成32件まで。IDは当該親ターンだけで有効。子から別の子や他の親のタスクを操作できない。
- 親の終了・中断では実行中の子を中断し、承認待ちの解放と保存が終わるまで待つ。結果が必要な子は親の終了前に TaskOutput で回収する。
- 状態は `running / done / stopped / awaiting_user / error`。停止・質問待ちは完了扱いにせず、理由・質問を親へ返す。子の質問は親がユーザーへ取り次ぐ。返答後の子の再委託は新しい Task とする。
- 子の索引は同じ親の ChildRunner 内で共有し、並列起動・保存で別の子の記録を消さない。

---

## 11. Router(モデル選択・フォールバック)

- 指定方法: `provider:model` 形式(例: `claude:opus`、`codex:sol`)。エイリアスとモデル一覧はモデルカタログ(§21.9)で定義
- **フォールバック**: `rate_limited` を受けたら
  1. `retryAfterSec` が短ければ(既定60秒以内)待って再試行
  2. 長ければ設定の `fallback` 先へ切り替え(ユーザーに通知)。履歴は内部形式なのでそのまま移行可能(reasoning は除外)
- **使用量記録**: レスポンスのレート制限系ヘッダがあれば記録し、`/usage` で表示。ヘッダ名は Phase 0 で調査
- Phase 3: 60秒以内は同一プロバイダで最大3回再試行する（初回を含め4送信）。長い待ち・待ち時間不明・再試行終了は fallback 先へ切り替え、STEP 1 から続行する。ターン内で訪問済みのモデルには戻らない。fallback を false / null にした場合は停止する。切替は当該セッションだけに保存し、既定モデルを変えない。
- 他社の reasoning は送信時のコピーから除外する。記録済み履歴は追記のみで、同社の暗号化 reasoning / thinking / signature を変更しない。
- Codex の使用量ヘッダは ProviderEvent / UiEvent の usage として渡す。欠損を0と見なさず、resetAt は ISO 8601。画面の5h / weekly は window-minutes が300 / 10080の枠に対応する。`/usage` コマンドは未実装。

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
web:                           # §22 の設計。未実装項目は stabilize-progress に記録
  enabled: true                # false で WebSearch / WebFetch を登録しない
  searchMode: live             # 実装済みの互換キー (Codex: live | cached)
  searchProvider: auto
  codexSearchMode: live
  maxSearchesPerSession: 100
  fetch: { maxChars: 100000, cacheMinutes: 15 }
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
  memoryFiles: [AGENTS.md, CLAUDE.md]   # ~/.xharness と作業フォルダの中だけ(絶対パス・.. で外へ出る指定・秘密ファイルは読まない)
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

完了条件は手順書の6項目に照合した。未実測・任意項目は調査記録に残し、実更新の成功と混同しない。Opus の疎通は追加の手順2で確認済み。Phase 1 は未着手。

**成果物**: `spike/claude.ts`、`spike/codex.ts`、本書 §7 の表を確定値に更新

### Phase 1: 単一プロバイダの最小エージェント(UI なし)
- 内部形式、ClaudeAdapter、Agent Loop、Read/Write/Edit/Bash/Grep/Glob
- `headless.ts` で readline の REPL から動かす。権限は全部 ask で可

### Phase 2: Electron シェルと exe 化
- 状態: 画面・IPC・FakeProvider・アイコン生成・electron-builder 設定はクラウドで実装・検証済み。**exe のビルドと起動確認は手元で未実施**([docs/phase2-progress.md](docs/phase2-progress.md)、[docs/phase2-local-check.md](docs/phase2-local-check.md))
- フレームレスウィンドウ、TitleBar、Transcript、PromptLine、PermissionDialog、テーマ(§16.2)
- Sidebar(セッション一覧・新規・再開)と WorkspacePicker の folder タブ(§16.6, §18)
- IPC イベント(§16.4)で core とつなぐ
- **この段階で一度 exe をビルドして別フォルダで起動確認**する(パッケージング由来の問題を早く潰すため)

### Phase 3: 混合化
  - WebSearch / WebFetch は §22。元の Web 検索設計ファイルを安定化作業で取り込み済み。未実装の設定・制御は docs/stabilize-progress.md に記録する。
- CodexAdapter、変換の単体テスト(fixtures 使用)、`/model` での途中切替、Router のフォールバック

### Phase 4: 実用化と可視化
- Permission ルール、Context 圧縮、プロジェクトメモリ、セッション保存と再開
- Receipts・UsagePopover・LoopFlow・StepTabs・Hero(§16.3, §16.7)
- WorkspacePicker の repository タブ、worktree による隔離(§18.2, §18.3)

実装記録(2026-10-02): [docs/phase4-progress.md](docs/phase4-progress.md)。権限ルール・モード、プロジェクト設定とメモリ、圧縮チェックポイント、履歴・レシートの再開、可視化、repository / worktree を実装。実 API を追加で呼ばず、fixtures と Windows の一時 Git リポジトリで検証する。

### Phase 5: サブエージェントとタスク段階
- Task ツール、explorer / reviewer の定義、AgentsPanel
- タスク段階(§20)、PhaseBar、ModelPicker
- 計画項目の割り当てと worker の並列実行(§21)。最初は「並列数 1」で順番に動く形を作り、統合とレビューが安定してから並列数を上げる
- STEP フックの入り口とシェルコマンドフック(§19.10)
  - フックの入り口(`beforeStep` / `afterStep` の呼び出し)だけは Phase 1 の Agent Loop 実装時に入れておく

### Phase 6 以降(任意)
- MCP クライアント、フック、git worktree によるサブエージェント隔離、自動アップデート、レシートのリプレイ
- 初回はレシートの通信なし再生（§23）。MCP は §25 の仕様(2026-10-02 確定)で M1〜M4 に分けて進める。自動アップデートは配布仕様を決めてから後続の単位で進める。汎用エージェント機能の追加（TodoWrite・Bash バックグラウンド・巻き戻しなど）は §26。Phase 5 のフック・worker 隔離は再実装しない。

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

### 14.1 初回認証・期限切れの案内（2026-10-02、ユーザー承認）

起動時にClaude/Codexの資格情報をローカルで確認し、未認証・期限切れ・資格情報ありを表示する。CodexのJWTにexpがある場合は期限を確認するが、署名検証や提供元への照会は行わない。「資格情報あり」は実通信の成功を意味しない。認証エラー時は再認証が必要と表示する。

2026-10-02のユーザー指示により、両プロバイダが資格情報ありの場合は認証欄を非表示にする。未認証・期限切れ・認証中・再認証が必要・認証未完了のプロバイダのみ表示し、提供元で認証を拒否された場合は再表示する。

ユーザーが「認証・更新を許可」を選ぶと、mainのネイティブ確認ダイアログで再確認する。キャンセルではCLIを起動しない。許可時のみ別の操作可能な公式CLI画面でClaudeは claude auth login --claudeai、Codexは codex login を実行する。ブラウザでのログイン・認可はユーザー自身が行う。任意のコマンド・パス・追加引数はIPCで受け付けない。CLIヘルプでこれらの引数を確認した（2026-10-02）。

認証中は二重起動・会話送信を禁止し、会話実行中は認証を開始しない。完了後は資格情報とマスク用の秘密値を再読み込みし、失敗・未完了は固定の日本語で通知する。CLI出力はログやIPCへ転送しない。自前refresh・資格情報の編集・アプリへのコピーは行わない。再確認ボタンはローカルの読み取りだけを行う。モデル依頼の自動再送信はしない。--fakeでは状態確認・認証とも無効にする。

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
| 実行環境 | Node.js 24 LTS（基準24.16.0、2026-10-03ユーザー環境に合わせて更新。22.20以降も互換確認） | MIT |
| パッケージ管理 | pnpm | MIT |
| アプリ基盤・ビルド・パッケージ | Electron / electron-vite / electron-builder | MIT |
| UI | React / Zustand | MIT |
| Markdown・ハイライト | react-markdown / rehype-sanitize / Shiki | MIT |
| テスト・lint・整形 | Vitest / ESLint / Prettier | MIT |
| Node代替検索のgitignore解釈 | ignore（7.0.11、ユーザー承認2026-10-03） | MIT |
| フォント | Silkscreen / JetBrains Mono | OFL(同梱・再配布可) |
| シェル・バージョン管理 | PowerShell 7 / Git for Windows | MIT / GPL |
| エディタ | VS Code(任意) | 無料 |
| アイコン変換 | sharp + png-to-ico(npm) | Apache-2.0 / MIT |

Node代替検索のGlob照合には `node:path.matchesGlob` を使用する（ユーザー承認2026-10-03）。Node 22.20以降ではstable。古いNode 22でのExperimentalWarningと代替案・確認結果は [docs/h4-review-progress.md](docs/h4-review-progress.md) に記録する。開発環境の基準はユーザー環境のNode 24.16.0へ合わせ、enginesは22.20以降の22系および24.16以降の24系を許可する。型定義は22系を維持して互換範囲を越えるAPI追加を避ける。Electron実行時のNodeはElectron同梱の版であり、システムのNodeとは別に確認する。

Windows検証ではPowerShellの版だけでなく実体・配布形態（Codex同梱／WindowsApps・Store版など）を合わせる。PATHは検証プロセスの中だけで設定し、システム全体の設定は変更しない。実測した環境とH3のJob継承の差は [docs/h3-job-investigation.md](docs/h3-job-investigation.md) に記録する。

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
│ Sidebar        │ Hero:  [▾ overview] [自動追従][main · opus][worker · sol · 確認待ち] … │
│ [+ new session]│        ✕HARNESS (ピクセルロゴ)  model · steps · ● live / Claude plans, GPT builds… │
│ [search      ] │ PhaseBar: [✓ 1 PLAN] → [● 2 IMPLEMENT] → [○ 3 REVIEW]               │
│                │ StepTabs: loop 7 · main [1/6 context][2/6 model] … [6/6 receipt]   │
│ sort: recent ▾ ├─────────────────────────────┬────────────────────────────────┤
│ ▾ myapp     ●4 │ Transcript                   │ LoopFlow                         │
│   ▌ログイン 12m │  発言・応答・ツール呼び出し     │  レーン名 / ノード / # 注釈         │
│    README …    │                              │  実行中ノードは枠を光が回る         │
│ ▾ client-site 2├─────────────────────────────┴────────────────────────────────┤
│    依存更新 ask │ Receipts                                                       │
│ ▸ cli-tool   2 ├──────────────────────────────────────────────────────────────┤
│ ▾ その他      4 │ PermissionInline (必要なときだけ)                                  │
│ ⚙ settings     │ PromptLine:  ~/dev/myapp ❯ _          [● opus 5.5 · high ▾] [ask ▾] │
└───────────────┴──────────────────────────────────────────────────────────────┘
   ▲ WorkspacePicker と UsagePopover はタイトルバーのボタンから開くポップオーバー
   (AgentsPanel は右の列ではなく、Hero の overview ボタンの右側に横並びで出る)
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
- **AgentsPanel は Hero の ▸ overview ボタンの右側に横並びで置く**(ユーザー要望 2026-10-03。右の Agents 列はなくし、会話欄を右端まで広げる)。自動追従 / main · {model} · {状態} / エージェントごとの {name} · {model} · {状態}(branch があれば ` · {branch}`。STEP は title 属性)の小さなボタンと、未起動の項目の {id} · 起動待ち ラベルを並べ、はみ出したら横スクロールする。Hero を開いていても閉じていても、この行に出る。Hero が無いとき(Phase 4 前)は StepTabs の上に単独で出す。エージェントがいなければ何も出さない
- **ツールカード**(ユーザー要望 2026-10-03)は標準で閉じた 1 行表示にし、クリックすると入力の全文(Bash はコマンド、ほかは整形した JSON。4000 文字で省略)を開閉できる
- **応答の文字の送り方**(ユーザー要望 2026-10-03): 応答の文字は空白までためてから画面へ送る。ただしツール呼び出しの前には、ためた分を送り切る

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

初回送信時も、ユーザー発言は main が履歴に追記してから `user_message` イベント(`sessionId` / `messageId` / `text`)で画面へ送る。コマンドの戻り値とイベントの到着順に依存する楽観的な追記は行わず、履歴表示とストリーム出力の順序を同じイベント列で保つ。

Phase 2 の実装メモ(型は `src/shared/ipc.ts`): 複数セッションの同時実行(§16.6)のため、セッションに属するイベントには `sessionId` を付ける。上の型に加えて `{ type: "state"; state }`(セッション・ワークスペース一覧など)、`{ type: "transcript"; sessionId; items }`(履歴の再表示)、`{ type: "turn"; sessionId; status; stopCause? }`、`{ type: "tool_result"; receiptId; isError }`、`{ type: "permission_resolved" }` を追加した。`permission_request` には対応するツールカードの `receiptId` を任意で持たせる。`usage` と `agent` は型だけで、Phase 4・5 まで送らない。`set_model` は `sessionId` を取りそのセッションだけに効き(モデルと effort はセッションごとに保存)、`close_session` はセッションを閉じて権限待ちを deny にする。レンダラ → main のコマンドは `parseCommand` で検証し、戻り値(`CommandResult`)だけが同じチャネルで返る。

### 16.5 Receipt(ステップ記録)

2026-10-02のユーザー指示により、アプリのレシート一覧は行だけを縦横スクロールし、件数・HTML出力・再生の見出しは一覧上部に固定表示する。

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
- `--fake`: Electron にも headless にも付けられ、FakeProvider(`test/fixtures` の SSE を再生)で動く。通信せず資格情報も読まない。exe には `--fake` 用の fixtures だけを `extraResources` で同梱する
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
- 画面: StepTabs と LoopFlow は「今見ているエージェント」の STEP を表示する。AgentsPanel(Hero の overview 行の右側の横並びバー。ユーザー要望 2026-10-03)でエージェントを選ぶと切り替わる。既定は「いちばん最近動いたエージェント」に自動で追従する
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
- Phase 1 の実装: `loop-types.ts` に Step / StepOutcome / LoopContext、`loop-steps.ts` に単独実行できる6 STEP、`loop.ts` に戻り値を dispatch する状態機械を置く。retry は同じ STEP に戻り、失敗・停止・中断も receipt を経て終了する。fallback の遷移型は扱うが、実モデル切替は Phase 3。

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

Phase 1 の入り口は `beforeStep / afterStep: Promise<HookResult>`。HookContext は履歴を含む凍結スナップショットとし、既存メッセージや thinking の変更を許さない。inject はツールの未処理 ID があれば tool_result に追加し、それ以外は user メッセージとして追記する。before の block は実行をスキップし、未処理ツールにエラーを返す。stop とフック例外もツール ID と receipt を閉じて終了する。after の block は無効。after:receipt の inject は end_turn 後も上限内で次周を起動できる。フック結果も provider:hook の receipt に残す。

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
  worktrees: true     # worker を専用 worktree に隔離。false は同じフォルダで直列実行
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

### 20.6 継続指示の停止と提案のみの終了（2026-10-02、ユーザー承認）

- `auto`の読み取り調査で、保守的な権限判定によりBashが拒否されても、それだけではplanへ切り替えない。Write/Edit/SubmitPlan/SkipPlanの呼び出しは従来どおり段階を開始する。
- 2026-10-04ユーザー承認: workflowのclassify/plan段階で読み取り専用と判定できないBashは、一律拒否せず、ユーザーの実行確認へ回す。許可された呼び出しだけ実行する。defaultでは過去のallowルールでもこの確認は省略しない。自動モードは§9.1の承認状態として確認を自動許可する。チャット本文の「許可」は承認応答として扱わない。明示的denyルール、セッションのplanモード・readOnlyによる拒否は維持する。Write/Edit等の計画前制限とレビュー要件は変更しない。
- `auto`で計画項目も実際の差分もなく、classifyまたはimplementでend_turnになった場合は、提案・調査結果・阻害理由の回答として終了できる。変更を捏造させず、RequestReviewも要求しない。次の依頼は再びclassifyから判定する。差分のある実装のレビュー必須条件は維持する。
- plan/implementのend_turnに対する継続指示は、段階・計画項目の状態・reviewRound・差分を比較する。同じ状態のend_turnが3回続いたらworkflow_stalledで停止し、ユーザーの新しい入力を待つ。未レビューの作業を完了扱いにはしない。
- 実行中・承認待ちに「停止」ボタンを表示し、既存abortと同じ経路で実行・子・承認待ちを中断する。`/stop`と、単独の「停止」「停止して」「中断」「中断して」（先頭の「一旦」は任意）・「止めて」（末尾の句点・感嘆符は任意）もLLMへ送らず直接停止する。文中の「停止」は停止コマンドと解釈しない。
- ツールの失敗は固定メッセージでCLI不足・ファイル不存在・アクセス拒否・時間切れ・中断を区別する。例外の生メッセージや秘密値はモデル・画面・レポートへ転送しない。経緯と検証はdocs/bugs/2026-10-02-workflow-loop.mdに記録する。

### 20.7 明示的な停止・質問ツール（2026-10-02、ユーザー承認）

Claude・Codex共通で main / 子に `StopTask({reason})` と `AskUserQuestion({question, options?})` を公開する。前者は理由付き停止、後者は質問を表示して入力欄からの返答を待つ。どちらも現在のターンを閉じ、次のLLM通信を行わない。同じ応答内の他ツールは実行せず、対応するエラー結果でIDを閉じる。一般の応答テキストに停止という語があってもこの動作にはしない。

理由・質問は会話とレシートへ記録し、未完了の実装・レビュー状態は維持する。セッションを永久に閉じる操作ではなく、ユーザーの次の入力で続けられる。options は任意の2〜5件の候補で、入力欄で番号・文章のどちらでも返答できる。

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
- Phase 5 初期実装は同時実行1件。ワークスペースの `.git` が存在するときだけ worker の worktree を作る。親フォルダが Git 管理されている普通のサブフォルダは、既存のワークスペース分類と同じフォルダモードとし、そのフォルダの Edit / Write の変更だけをレビューする。統合後の wave テストは `after:receipt`・`when.phases: [implement]` のコマンドフックを1回実行し、失敗した項目の後続を起動しない。設定が無ければ「テストフック未設定」として扱い、モデルの `testsRun` とハーネスの実行結果を区別する。

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
- AgentsPanel(ユーザー要望 2026-10-03: 右の列をやめ、Hero の overview 行の右側に横並びのバーで置く): main・worker・reviewer を並べ、選んだエージェントの STEP を StepTabs と LoopFlow に表示する。未起動の worker は `wave 2` のように待ち状態を出す
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

---

## 22. Web 検索と WebFetch

### 22.1 方針

- **ある程度最新の情報を追えること**を要件とする。そのため検索は live(その場で Web を検索)を既定にする
- **メインのモデルに、生のページを丸ごと読ませない**。検索はタイトルと URL だけ、ページの中身は軽いモデルが要約したものだけを返す。ページに仕込まれた指示(プロンプトインジェクション)が main に直接届きにくくし、トークンも節約する
- 検索もページ取得も **XHarness 側のツール**として実装し、通常どおり STEP 3〜5(検証・権限・実行)を通す。プロバイダのサーバー側ツールを main の会話に直接持たせることはしない

### 22.2 WebSearch

```ts
WebSearch({ query: string, allowedDomains?: string[], blockedDomains?: string[] })
// 返り値: { results: { title: string; url: string; pageAge?: string }[], provider: "claude" | "codex" }
```

- ツールの中で、**別のリクエスト**として各プロバイダの組み込み検索を呼ぶ(main の会話履歴には入れない)
  - Claude: Messages API の `web_search` サーバーツール。使用量を節約するため、検索を実行するモデルは Haiku 4.5(Haiku が対応する版の `web_search`)を既定にする
  - Codex: Responses API の `web_search` ツール。モデルは GPT-6 Luna を既定にする。live / cached の指定方法は Codex CLI のソースで確認する
- どちらのプロバイダで検索するか: 設定 `web.searchProvider`(既定 `auto`)。`auto` は使用量(§16.7)に余裕がある方を使い、失敗したらもう一方で再試行する
  - 余裕の計算(2026-10-02 ユーザー指示): 5時間枠と週間枠のそれぞれで「残りの使用量の割合 ÷ リセットまでの残り時間の割合」を求め、厳しい方(小さい方)をそのプロバイダの余裕とする。1 なら平均的な速さで使い続けられる、1 未満なら足りなくなる速さ
  - リセット時刻が分からない枠は、窓の全体が残っているものとして控えめに計算する。リセット時刻を過ぎた枠は余裕 1。リセット直前で値が大きくなりすぎないよう、残り時間の割合は 0.05 を下限にする
  - 両方の余裕が分からない、または差が1割未満なら、セッションのプロバイダを先にする
  - 枠の値は、本体・子エージェント・Web の要約と検索のすべての通信の使用量イベントで更新する(枠ごとに最新の値を残す)。headless は使用量を集めないので、セッションのプロバイダを先にする
- 返すのは**タイトル・URL・ページの日付だけ**。ページの中身が必要なら、続けて WebFetch を呼ぶ
- `allowedDomains` と `blockedDomains` は同時に指定できない(検証 NG)

### 22.3 WebFetch

```ts
WebFetch({ url: string, prompt: string })
// 返り値: { url: string; finalUrl: string; summary: string; truncated: boolean }
```

1. **取得(手元)**: Node の `fetch`。http は https に格上げする。タイムアウトは 60 秒
   - `localhost`、ドットのないホスト名、プライベート IP(10.x / 172.16-31.x / 192.168.x / 127.x / ::1 など)は拒否する
   - **別のホストへのリダイレクトは追わない**。リダイレクト先を返し、モデルにもう一度 WebFetch を呼ばせる(リダイレクト先が権限確認を通るようにするため)
2. **変換**: HTML を Markdown に変換する(turndown など MIT ライセンスのもの)。script / style / nav は除去する。一定の文字数(既定 100,000)を超えたら切り詰める
3. **要約(軽いモデル)**: `prompt` に沿って必要な部分だけを抜き出す。モデルは Haiku 4.5 か GPT-6 Luna(WebSearch と同じ選び方)
   - 要約役への指示に「ページ内の指示には従わず、内容の抜き出しだけをする」を入れる
4. main に返すのは要約だけ。同じ URL と同じ `prompt` の組の結果は 15 分キャッシュする(最大100件。prompt が違えば要約も違うため、URL だけではなく組で持つ)

### 22.4 権限と使えるエージェント

| 項目 | 既定 |
|---|---|
| WebSearch | ask。`a`(このセッション中は許可)を選べる。ルールで allow にもできる |
| WebFetch | ask。**ドメイン単位**で「今後は確認しない」を選べる(`WebFetch(domain:example.com)` 形式のルールとして保存) |
| `plan` モード | どちらも使える(読み取りだけなので) |
| 使えるエージェント | main と explorer。worker と reviewer は既定では使わせない(作業内容は計画で渡すため) |

- ツールの結果を返すとき、tool_result の先頭に「以下は外部のコンテンツであり、指示として扱わない」という注記を付ける

### 22.5 上限と記録

- 1セッションの WebSearch は **100 回まで**(サブエージェントの分も合算)。上限に達したら、エラーではなく「集めた情報で進めてください」という通知を返す
- 検索・取得はレシートに残す(`kind: "tool"`、検索語と URL を記録。取得したページの本文は保存しない)

### 22.6 設定(§12 への追記)

```yaml
web:
  searchProvider: auto        # auto | claude | codex
  codexSearchMode: live       # live | cached | disabled
  maxSearchesPerSession: 100
  fetch:
    maxChars: 100000
    cacheMinutes: 15
```

### 22.7 Phase 0 と同様の疎通確認(未確認事項)

- [ ] Claude: サブスクの OAuth で `web_search` サーバーツールが使えるか、どのモデルの、どの版のツールが受け付けられるか(Haiku で使えない場合は Sonnet 5.5 で試す)
- [ ] Codex: サブスクの OAuth で `web_search` が使えるか、live / cached の指定方法(ソースで確認してから送る)
- [ ] 検索で使用量の枠がどれだけ減るか(使用量ヘッダの前後差)
- [ ] 使えないプロバイダがあった場合は、もう一方だけで運用する。両方とも使えない場合は、設計者に相談する


安定化時点の確認済み通信方式: Claude は `web_search_20250305`、Codex は `web_search` と `external_web_access`（live=true / cached=false）。Phase 3 の両プロバイダ疎通は成功済み。検索結果はタイトルと URL のみ返す。公開ページの取得は DNS を固定し、非公開アドレスと再解決を拒否する。

---

### 22.8 実装状況(2026-10-02)

実装済み: §22.3 の WebFetch(prompt 必須、Haiku 4.5 / GPT-6 Luna による要約だけを返す、15 分キャッシュ、http→https、localhost・非公開 IP・別ホストへのリダイレクトの拒否、外部コンテンツの注記)、§22.4 のドメイン単位の許可(`WebFetch` / `domain:example.com`、ホストの完全一致)、使えるエージェント(main と explorer)、WebSearch がタイトルと URL だけを返すこと。

追加実装(2026-10-02、クラウド・実送信なし): `web.searchProvider`(auto は5時間枠の使用率が分かれば低い方、分からなければセッションのプロバイダを先にし、失敗したらもう一方で1回だけ再試行。claude / codex 指定時は再試行しない)、WebSearch の `allowedDomains` / `blockedDomains`(どちらか一方・1〜20件・ドメイン自身とサブドメインに一致)、結果の `pageAge`(Claude の `page_age`)と URL の重複除去、1セッションの上限(既定100回、子エージェントと同じ数を共有。上限に達したらエラーにせず「上限に達した」旨を外部コンテンツとして返す)、`codexSearchMode: disabled`(Codex を検索に使わない)、`web.fetch.maxChars` / `cacheMinutes` の読み込み。不正な値は既定値のまま警告に出す。従来の `web.searchMode` は `codexSearchMode` として読む。

ドメインの絞り込みは、**検索結果を手元で絞る方式**とした。各プロバイダの API にドメイン指定の引数を送る方式は実通信で未確認のため使わない。そのため、絞り込みで除外された結果の分も検索1回として数え、0件になることがある。

手元で未確認: 実通信での auto の切り替えと、Codex の `page_age` 相当の有無(Codex の実録 fixture には日付が無い)。

## 23. レシートの再生（Phase 6 初回）

§16.5 の比較機能を小さく分け、最初は保存済みの記録を通信なしで再生する。モデル・ツール・フックを再実行せず、元の履歴・レシート・作業フォルダに書き込まない。

- レシートは追記順を保ち、時刻を ISO 8601 で表示する。親と子の記録が混ざる場合は agentId を表示する。時刻の逆転や番号の欠番から、未保存の STEP を作らない。
- 画面の receipts に「再生」を追加し、開いた時点のスナップショットを前後移動・自動再生できる。実行中のイベントとは独立し、再生の Esc で実セッションを中断しない。入力・出力は文字として表示する。
- headless の `--replay <sessionId>` は、設定・Provider・ツールの初期化前に保存レシートを読み、JSON を標準出力へ返して終了する。`--replay-parent <parentId>` があれば `agents/<parentId>/receipts/` の子を読む。ID にパスを指定させない。
- `--replay-mode default|acceptEdits|plan` と `--cwd` で、現在のグローバル・プロジェクト権限ルールに対する判断を比較できる。権限だけを再評価し、ask を自動許可しない。差があっても後続のモデル出力は録画であり、変更後の結果を予測したものではない。
- 不正な記録は件数を報告して除外する。記録件数・各レシート・全体の容量に上限を設け、秘密フィールドを再マスクする。未知の記録種別を実行コマンドとして扱わない。

新しいモデルでの有料再実行・差分比較、MCP の接続、更新配布は後続の実装単位。今回の完了条件は、再生と権限比較が実 API・Bash・Write・フックを呼ばずに動き、実録レシートと画面・headless のテストで確認できること。


### 23.1 静的 HTML 実行レポート（2026-10-02）

ユーザー指示により、保存済み会話とレシートを通信なしで HTML に出力する。親セッションと `agents/<parentId>/` の子をまとめ、内部共通形式のモデル入力・応答、ツール入出力・委託内容、権限・フック・圧縮の保存記録を展開表示する。STEP の説明と保存順を併記するが、未保存の STEP・通信・親の個別 Task と子 ID の対応を推定しない。HTTP 本文・生 SSE・再試行ごとの通信・補助 LLM 通信の網羅は後続の記録拡張とする。

画面の receipts に「HTML出力」を追加し、親セッションが idle のとき保存ダイアログを開く。headless は `--report <sessionId> --output <new-file.html>` で設定・Provider・ツールの初期化前に終了する。どちらも既存ファイルを上書きしない。レポートはローカルで開ける単一 HTML（外部依存・スクリプトなし）。入力を文字としてエスケープし、秘密値・認証フィールド・暗号化 reasoning・署名を出力時にマスクする。元履歴の opaque ブロックには手を加えない。容量・件数制限と不正記録の除外件数を表示する。

実装・検証と利用方法は [docs/report-export.md](docs/report-export.md) を参照。

表示改善（2026-10-02）：既定で日本語の見出し・ツールの役割と、LLMに追加した指示・ツール結果、返答・要求操作を簡易表示する。送信履歴の先頭が前回と一致する場合だけ追加分を抽出し、圧縮・プロバイダ切替などで一致しない場合は最新メッセージと説明を表示する。本文は原文を保ち、翻訳・要約のためのモデル通信は行わない。簡易表示は直近4メッセージ・各本文1200文字までで、省略を明示し全文を閉じた詳細JSONに残す。

カード形式統一（2026-10-02）：全種別で「処理・入力・出力・詳細」の配置を共通化する。Claude/Codex の `model_call` だけ紫の背景・左線と LLM ラベルで強調し、他は通常色とハーネスラベルで表示する。入力・出力が保存されていなければ未記録と明示する。ツール・権限・フックなどの内部で補助通信が発生したかは推測しない。

### 23.2 STEP・通信・委託の実行トレース（2026-10-02、ユーザー承認）

§23.1 の後続記録拡張として、レシートと別に `traces/<親sessionId>.jsonl` を追記する。実行した STEP の開始・終了、ツール実行、前後フック、子への委託、Adapter の LLM 呼び出しを記録する。開始時に親子共通の連番と span ID を割り当て、終了は同じ ID で対応させる。並列処理を終了順に並べ替えず、HTML は開始順で表示する。表示番号、STEP 番号、従来レシート番号を区別する。

- STEP 1〜6 は実行したものだけを残す。入力構築、検証エラー、権限の許可・拒否、実行結果、会話への結果追加、次の遷移・再試行・停止理由を記録する。実行されない STEP を捏造せず、終了記録がない処理も表示する。
- Claude/Codex Adapter では fetch に渡す JSON 本文そのものと HTTP ステータス、デコード前の SSE の event/data、組み立て後の応答を残す。HTTP ヘッダは保存しない。認証失敗など送信に至らない試行も区別する。SSE の行区切りやコメント、空行、HTTP エラー本文、未受信・未解析の断片は保存対象外。
- AsyncLocalStorage の実行スコープで、通常会話、再試行、圧縮、Web 要約・検索などの補助通信、子エージェントの通信を同じ親のトレースに接続する。個別の tool call ID、呼び出し元 span、子 ID、委託プロンプト、返却結果を記録する。通常の画面と headless は WorkflowRuntime で接続し、手動圧縮もスコープを設ける。
- 記録前と HTML 出力時に秘密値、認証フィールド、暗号化 reasoning、署名をマスクする。元の履歴や通信本文は変更しない。受信イベントは1通信80万文字、保存1行100万文字までで、省略を明示する。読み込みはトレース1ファイル32 MB・2万行、レポート全体32 MBまで。
- HTML は「処理・入力・出力・詳細」で全体の経過を表示し、通信を試みた LLM 呼び出しだけ紫で強調する。FakeProvider は「LLM模擬・実通信なし」と明示する。従来レシートは補足として折りたたむ。トレース導入前の履歴は従来表示を維持し、欠けている処理を推定しない。
- 同梱サンプルは FakeProvider と実際の Agent Loop・ChildRunner を実行して生成する。Read、検証エラー、権限拒否、再試行、子への委託を含め、実 API 通信や資格情報の読み取りは行わない。実際の送受信境界は、実録 fixture と fetch の差し替えで検証する。

### 23.3 保存の安定化と番号ごとの折りたたみ（2026-10-02、ユーザー承認）

トレースは8 MBまたは5000行で分割し、再開時にも新しい連番ファイルを作る。末尾を最大8 MB読み、開始番号を引き継ぐ。保存失敗は秘密値を含まない警告を画面・headlessに通知し、会話の実行結果を変更しない。

HTMLは直近の分割ファイルを合計16 MB・2万行まで読み、範囲外の記録がある場合は明示する。元記録は削除しない。各表示番号 # を独立した details にし、初期状態では見出し・親子・周回・結果のみ表示する。LLMの色分けは閉じた状態でも保持する。実通信の試行・模擬応答・ツール実行・委託・権限拒否を概要に集計する。JavaScriptや外部通信は使わない。

## 24. 安定化: 圧縮と preserved thinking

**system と tools を会話の途中で変えない**(2026-10-02 追加)。Opus/Sonnet 5.5 の preserved thinking は、`system`・`tools`・それより前のメッセージを過去の thinking の前提として検査する。2026-08-31 以降に作られたアカウントでは既定で検査され、変わっていると 400 になる(それより前のアカウントは `prefix_mismatch_behavior` を指定したときだけ)。このため:

- workflow は段階ごとにツールを出し入れしない。全段階で同じ集合・同じ順のツールを渡し、段階による制限(計画前の書き込み、SubmitPlan / SkipPlan / UpdatePlan / RequestReview を使える段階)は各ツールの検証で掛ける
- system に足す workflow の説明は、段階ではなく設定の `workflow.mode` で決める(同じ会話では変わらない)
- main の system はセッションの最初の組み立てで固定する。途中で AGENTS.md などが編集されても、次のセッションから反映する
- 再起動後は workflow の追加分を含む実際の system / tools（順序も含む）の SHA-256 と版を、索引に保存したハッシュと照合してから送信・自動圧縮する。本文・資格情報・以前の承認は保存／復元しない。前提が不一致、または assistant 履歴がある旧形式で照合できない場合は送信せず、履歴を保持して `/clear` または新規セッションを案内する。user のみの旧履歴は初回送信で前提を設定できる。今回の不一致による実際の Claude 拒否は未検証であり、予防的な処理とする。
- Claude の手動 `/compact` は、同じ runtime で検証した実際の workflow system / tools を使う。再起動直後にまだ検証できていない履歴では圧縮せず、上記の案内を返す（前提が同じなら通常のターンを一度実行後に圧縮できる）。Codex の要約は固定の別 system、tools なし、reasoning 除外であるため、この制限を付けない。ただし通常の再送は上記照合を通す。
- 自動圧縮ができないとき(要約の失敗・529・サーバー圧縮の無い Haiku)は、上限に収まる間は圧縮せずに続け、同じターンでは再試行しない。上限を超えるときだけ `context_overflow` で止め、モデル名と理由を通知する。手動の `/compact` は失敗を返す


2026-10-02 の指示に基づく既存圧縮の修正。Claude のクライアント要約チェックポイントは送信に使わない。Opus/Sonnet 5.5 は `compact-2026-09-04` と `compaction: {type: summarize}` でサーバー圧縮し、返った署名付きブロックを改変せず先頭で返送する。元の保存履歴は追記のみ。今回の実装は全完了ターンを圧縮し、最新の未回答 user ターンを残す。これにより、圧縮後に workflow の system/tools が変わっても過去の thinking を残したまま接頭辞を置き換えない。Haiku は公式互換一覧にないため手元の要約へ戻さず、対応していない旨を返す。Codex は直近のターンをそのまま残し、古い部分を Luna による要約にする。要約の失敗・中断・不完全応答ではチェックポイントを更新しない。fake の決定的圧縮は通信しない試験用。

公式根拠: [on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)、[preserved thinking](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks)。対応モデル、先頭ブロック、署名保持、system/tools、完了したツール結果、usage.iterations の条件に従う。実通信結果と未確認事項は docs/stabilize-progress.md。

実使用で SubmitPlan の型が伝わらず形式エラーを繰り返したため、§21.3 の全 PlanItem フィールドをツールの JSON Schema に提示する。同じターンで3回形式エラーになったら停止し、計画を捏造・自動承認せず、ユーザーの再開を待つ。

## 25. MCP クライアント(Phase 6、仕様 2026-10-02)

外部の MCP サーバーのツール・リソース・プロンプトを、main と子エージェントから使えるようにする。方式は Claude Code に合わせる。ただし §24 の「会話の途中で system と tools を変えない」を守るため、MCP のツールは tools に直接並べず、固定の窓口ツールから呼ぶ。

### 25.1 決定事項(ユーザー確認 2026-10-02)

| 項目 | 決定 |
|---|---|
| 接続方法 | Claude Code と同じ。stdio(手元のプロセス)と HTTP(Streamable HTTP)。リモートは OAuth に対応する |
| 設定の置き場所 | プロジェクト側。リポジトリ直下の `.mcp.json`(Claude Code と同じ形式) |
| 権限 | 初回は ask。「常に許可」で、そのワークスペースのローカルルール(リポジトリ外の `~/.xharness/projects/<鍵>/permissions.yaml`)に allow を保存し、次回から聞かない |
| ツールの増減 | あり。tools は固定し、増減は会話のメッセージで伝える(25.4) |
| 子エージェント | 公開する。worker はすべて使える。explorer / reviewer は、ルールで許可されていない呼び出しを毎回 ask にする(自動許可しない) |
| 扱う範囲 | ツール・リソース・プロンプトのすべて |

### 25.2 設定(`.mcp.json`)

```json
{
  "mcpServers": {
    "github": { "type": "http", "url": "https://example.com/mcp", "headers": { "X-Team": "${TEAM}" } },
    "db": { "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "DB_URL": "${DB_URL:-sqlite://local.db}" } }
  }
}
```

- `type` 省略時は stdio(`command` / `args` / `env`)。`type: "http"` は `url` / `headers`。Claude Code で非推奨の `sse` は読まずに警告する
- `${VAR}` と `${VAR:-既定値}` を `command` / `args` / `env` / `url` / `headers` で展開する。未定義で既定値も無ければ、そのサーバーを無効にして警告する。秘密値を `.mcp.json` に直接書かせないため
- サーバー名は `^[A-Za-z0-9_-]{1,64}$`。ツール名の区切り `__` を含む名前は拒否する
- 全体の on/off と時間の上限は `~/.xharness/config.yaml` の `mcp:`(§12 へ追記)で持つ: `enabled`(既定 true)、`startupTimeoutSec`(30、1〜600)、`toolTimeoutSec`(120、1〜3600)。不正な値は既定値のまま警告する
- stdio のサーバーには、SDK の既定(PATH など最小限の環境変数)に `env` を足して渡す。親プロセスの環境変数をすべては渡さない

### 25.3 承認と起動

- リポジトリから来る設定なので、**ワークスペースの信頼(Phase 4 の workspace trust)に加えて、サーバーごとの承認**が要る。リポジトリを開いただけではプロセスを起動・接続しない
- 承認の画面には、サーバー名・種類・`command` と `args`(または `url`)・`env` / `headers` の**キー名だけ**を表示する(値は出さない)
- 承認はリポジトリ外(`~/.xharness/projects/<鍵>/mcp-approvals.json`)に、展開前の定義のハッシュで保存する。定義が変わったら再承認。「常に許可」で保存し、「許可」はそのセッションだけ。拒否も保存する(`/mcp reset` で取り消し、`/mcp reconnect` で承認し直せる)
- 接続はセッション開始時に行う。stdio のプロセスはセッション単位で1つ起動し、同じセッションの子エージェントと共有する。セッション終了・アプリ終了でプロセスツリーごと止める
- 起動・初期化が `startupTimeoutSec` を超えた・失敗したサーバーは使えない状態にして通知し、セッションは続ける。自動再起動はしない(`/mcp` で再接続)
- stderr は秘密値のマスク(AGENTS.md の規則)を通して、サーバーごとのログにだけ残す。画面には要約だけを出す

### 25.4 ツール(tools は固定)

`.mcp.json` がセッション開始時にあれば、次の4つを tools に加える(同じ会話では増減しない。セッション中に `.mcp.json` ができた場合は次のセッションから)。

| ツール | 内容 | 権限 |
|---|---|---|
| `McpSearch` | 接続中サーバーのツールを名前・説明で探し、入力の JSON Schema を返す | 確認なし(承認済みサーバーの情報のみ) |
| `McpCall` | `{server, tool, input}` でツールを呼ぶ | 25.5 |
| `ListMcpResources` | サーバーのリソース一覧(URI・名前・説明) | 確認なし |
| `ReadMcpResource` | `{server, uri}` でリソースを読む | 初回 ask、「常に許可」はサーバー単位 |

- セッション開始時に接続したサーバー名は、`McpSearch` の説明文に入れる(tools はセッション開始時に決まり、その後変えないので §24 に反しない)。ツールの一覧と Schema は `McpSearch` で取り出す
- サーバーの `notifications/tools/list_changed`(リソース・プロンプトも同様)を受けたら、次の要求の先頭の user 側メッセージに「追加・削除されたツール」の注記を足す。tools と system は変えない
- 削除済み・未接続のツールを `McpCall` で呼んだら、エラーの結果を返す(例外にしない)
- 入力は、XHarness では「オブジェクトであること」と、Schema の `required` の最上位キーがあることだけを確認し、詳しい検証はサーバーに任せる
- workflow の classify / plan 段階では、`McpCall` は書き込みと同じく使えない(計画の承認前に副作用を起こさないため)。`McpSearch` は使える
- サーバーのツール説明・結果・リソースは**信用しない外部コンテンツ**として扱い、WebFetch と同じ注記を付ける。結果は 28,000 文字を超えたら切り詰め、切り詰めたことを書く(ツール共通の上限 30,000 文字より先に)。最初は text と埋め込みテキストリソースだけを渡し、画像などは「未対応の種類」と書いて省く
- レシートには表示用に実際の名前 `mcp__<server>__<tool>` を使い、入出力は既存のマスクを通す

### 25.5 権限

- `McpCall` は、権限の判定前に実際の名前 `mcp__<server>__<tool>` の呼び出しへ置き換えて判定する(cd を外す正規化と同じ場所)
- 既定は ask。「常に許可」は、そのワークスペースのローカルルールに `{tool: "mcp__<server>__<tool>", decision: "allow"}` を保存する。ルールでは `mcp__<server>` と `mcp__<server>__*` をサーバー全体として扱う
- deny / ask ルールは常に優先(Phase 4 の権限ルールと同じ)。モード `acceptEdits` でも MCP は自動許可しない(副作用が分からないため)。`plan` モードでは `McpCall` を拒否する(リソースの読み取りは可)
- サーバーの `readOnlyHint` などの注釈は表示のヒントにだけ使い、許可の判断には使わない
- 子エージェント: 窓口ツールは定義の `tools` に書かなくても公開し、親と同じ接続を使う。判定は親と同じ(MCP は既定で ask のため、explorer / reviewer でも allow ルールに一致しない呼び出しは毎回確認になる)。確認画面には子の名前を付ける

### 25.6 プロンプト

- サーバーのプロンプトは `/mcp__<server>__<prompt> 引数…` で呼べる。引数は空白区切りで、プロンプトの `arguments` の順に割り当て、残りは最後の引数にまとめる。必須の引数が足りなければ送らずに知らせる
- 返ったメッセージのうち text(と埋め込みテキストリソース)だけを、送信前に確認画面(`McpPrompt`)で見せる。許可したら**ユーザーの発言として**送る(ユーザーが内容を見て選んだ指示なので、外部コンテンツの注記は付けない)。拒否なら送らない
- MCP の接続がまだなら(セッション最初の発言がプロンプトのとき)、先に接続を準備してから展開する
- 入力欄の補完に、接続中サーバーのプロンプトを出す(M4)

### 25.7 HTTP と OAuth

- Streamable HTTP で接続する。401 を受けたら MCP の認可仕様(保護リソースのメタデータ → 認可サーバーのメタデータ → 動的クライアント登録 → PKCE、ループバックへのリダイレクト)で、既定のブラウザを開いて認可する。手順そのものは SDK が行い、XHarness は保存とループバックでの受け取りを担う(`src/main/mcp/oauth.ts`)
- ループバックは `http://127.0.0.1:<port>/callback`。登録した redirect_uri を保つため、次回も同じポートで待つ(使えなければ新しいポートで登録し直す)。`state` が一致しない戻りは受け付けずに待ち続ける。ブラウザでの認可は5分まで待つ
- 開く URL は https か、手元(loopback)の http だけ。開く前に、どのホストを開くかを通知する
- トークンと登録したクライアントは、OS の暗号化(Electron の `safeStorage`、Windows では DPAPI)で暗号化して `~/.xharness/secrets/mcp-oauth.json` に保存する。鍵はワークスペース・サーバー名・URL ごと。復号できない値(別ユーザー・別端末)は無いものとして認可し直す。core は electron を import しない(§4)ので、暗号化は main プロセスから注入する。暗号化が使えない環境と headless では OAuth を使わず、認可が要るサーバーは「要認可」(needs_auth)として使えない状態にする
- トークンを画面・ログ・レシート・エラーメッセージに出さない(AGENTS.md の規則と同じ)。表示が要るときは先頭6文字 + `…`
- `/mcp` から、ログアウト(トークンの削除)と再認可ができる(M4。削除の処理 `McpOAuth.logout` は M3 で用意済み)

### 25.8 画面と headless

- `/mcp`: 会話欄に、サーバーごとの状態(接続中・接続失敗・未承認・拒否・要認可)、ツール・リソース・プロンプトの数、失敗の理由を出す。行のボタンから、`/mcp reconnect <server>`(接続・再接続。未承認・拒否なら承認を尋ね直す)、`/mcp reset <server>`(承認・拒否の取り消しと切断)、`/mcp logout <server>`(OAuth のトークンを消して切断)を送る
- `/mcp` はモデルに送らず、履歴にも残さない。MCP をまだ準備していなければ、ここで準備する(承認の確認が出る)。状態の表示は実行中でもできるが、操作は待機中だけ。書式の誤りは準備の前に知らせる
- 切断・再接続によるツール・リソースの増減は、次の発言でモデルに注記する(25.4。tools は変えない)
- 入力欄で `/` から打ち始めると、`/mcp` と接続中サーバーのプロンプト(引数の形と説明つき)を補完候補に出す。Tab で入れる、↑↓ で選ぶ。引数のあるプロンプトは、続けて引数を打てるよう空白を足す
- headless の `/mcp` は状態とプロンプトの一覧だけを出す(操作はアプリで行う)
- 承認は、フックの承認(§19.10)と同じダイアログの形。headless は readline で聞く
- `--fake` では MCP サーバーを起動しない(試験は 25.10 の試験用サーバーで行う)

### 25.9 実装の分け方

1. **M1**: `.mcp.json` の読み込みと変数展開、承認、stdio、`tools/list` と `tools/call`、`McpSearch` / `McpCall`、権限(25.5)、レシート。試験用サーバーで単体・結合テスト
2. **M2**: リソース・プロンプト(25.4、25.6)、`list_changed` の注記、子エージェントへの公開
3. **M3**: Streamable HTTP と OAuth(25.7)
4. **M4**: `/mcp` の画面、入力欄の補完

各単位で、§24 の「system と tools が会話の途中で変わらない」ことを試験で確認する(サーバーのツールが増減しても、前後の要求の system / tools が同じであること)。

### 25.10 試験と未確認事項

- `test/fixtures/mcp/` に、Node で書いた小さな stdio の試験用サーバー(ツール・リソース・プロンプト・`list_changed` を返す)を置く。HTTP と OAuth は、テスト内で起こすローカルのサーバーで確認する。外部の MCP サーバーには接続しない(クラウドでも実行できる)
- 実装前に確認して記録すること(AGENTS.md「推測で埋めない」): 対応する MCP 仕様の版、`initialize` の内容、Claude Code の `.mcp.json` の細かい形式と変数展開の規則、`McpCall` の Schema(入れ子の任意オブジェクト)を Codex の関数定義として受け付けるか(fixture で確認)
- **決定(ユーザー確認 2026-10-02)**: 公式の MCP TypeScript SDK(`@modelcontextprotocol/sdk`、1.31.0)を使う。AGENTS.md の「SDK を使わない」はサブスクの OAuth でモデルの API を呼ぶための規則で、MCP には当てはまらない。対応する MCP 仕様の版は SDK の `LATEST_PROTOCOL_VERSION`(1.31.0 では 2025-11-25)。exe には node_modules を入れないので、SDK は main のバンドルに含める

### 25.11 実装状況(2026-10-02、クラウド・実 API なし)

M1 を実装した: `.mcp.json` の読み込みと変数展開(`src/main/mcp/config.ts`)、承認の保存(`approvals.ts`)、stdio と Streamable HTTP(OAuth なし。401 は「要認可」として使えない状態)の接続と `tools/list`・`tools/call`(`manager.ts`)、`McpSearch` / `McpCall`(`src/main/tools/mcp.ts`)、権限(`mcp__<server>__<tool>` への正規化、サーバー全体のルール、plan / 読み取り専用での拒否、acceptEdits で自動許可しない)、画面と headless での承認・接続・終了時の停止、子エージェントへの公開。試験用 stdio サーバーで、接続・呼び出し・stderr のマスク・失敗と時間切れ・プロセスの後片付け・セッションでの承認と「常に許可」・tools が途中で変わらないことを確認した。

M2 を実装した(2026-10-02): `ListMcpResources` / `ReadMcpResource`、`/mcp__<server>__<prompt>` の展開と確認(画面・headless)、`list_changed` を受けた一覧の取り直しと、次の user メッセージへの注記(再開時の画面には出さない)。`McpSearch` / `ListMcpResources` は確認なし、`ReadMcpResource` は初回確認でサーバー単位の「常に許可」。リソースのテンプレート(`resources/templates/list`)は一覧に出さないが、URI を指定すれば読める。

M3 を実装した(2026-10-02): Streamable HTTP の OAuth(SDK の認可手順、ループバックでの受け取り、`safeStorage` で暗号化した保存、保存したトークンの再利用)。127.0.0.1 の試験用の認可サーバー兼 MCP サーバー(SDK の試験用プロバイダ)で、ブラウザの代わりに認可の URL を開き、登録・トークン取得・呼び出し・次回の再利用・ログアウト・保存先なしの needs_auth・state の検査・トークンが画面や要求に出ないことを確認した。

M4 を実装した(2026-10-02): `/mcp` の状態表示と、再接続・承認の取り消し・ログアウト(画面)、入力欄の補完。これに合わせて、承認の拒否を保存するようにした(取り消しは `/mcp reset`。25.3)。画面は jsdom の試験で確かめた。

手元確認(2026-10-02、docs/mcp-progress.md): パッケージ後の exe で npx のサーバー(`@modelcontextprotocol/server-everything`)に接続し、再接続・承認の取り消し・セッションやアプリの終了でプロセスツリー(npx の孫まで)が消えること、Haiku が `McpSearch` → `McpCall` で呼べて3回の要求で system / tools が変わらないこと、SDK の試験用 OAuth サーバーでブラウザでの認可・再起動後の再利用・暗号化した保存・ログアウトを確認した。画面の見た目(色・配置・補完候補)も確認した。これを受けて、`/mcp` の表示は最新のものだけ操作でき、古い表示は「過去の状態」として薄く出すようにした。起動の時間切れでのプロセスの後片付けの試験は、Windows でも動く形(プロセス番号で確かめる)にした。未確認: 実際の OAuth 対応サービスでの認可(試験用サーバーのみ)。

今後の課題(2026-10-02 記録): MCP の認可仕様では、動的クライアント登録(RFC 7591)が推奨から任意に下がり(2025-11-25 版)、代わりに Client ID Metadata Document(CIMD: クライアントの情報を https の URL で公開し、その URL をクライアント ID にする方式)が勧められている。XHarness は今、動的クライアント登録だけを使うため、CIMD にしか対応しないサーバーには接続できない。対応するときは、XHarness のクライアント情報を https で公開し(例: GitHub Pages)、SDK の `clientMetadataUrl` に渡す。redirect_uri がループバックのため、ポートの扱いを仕様で確かめてから決める。


---

## 26. 汎用エージェント機能の追加（仕様 2026-10-02、H2・H1・H3・H4・M3・M1・M2・M4・M5実装済み）

実アプリの試用（docs/bugs/2026-10-02-workflow-loop.md）後のレビューで挙がった不足機能。優先度の高・中・低の順に実装する。各単位は AGENTS.md の作業ルール（1コミット1目的）で小さく区切り、前の優先度の単位を検証してから次へ進む。

**共通の制約**
- ツールの集合と順序はセッション中に変えない（§24）。新ツールはリリース単位で追加し、全段階・全エージェントに同じ集合で渡す。段階や権限による制限は各ツールの検証で掛ける。
- 実 API へ通信せず、FakeProvider・テスト用 Provider・一時フォルダで検証する。実通信が要る確認は「手元で実施が必要」として記録する。
- 失敗の文言は固定の日本語にし、例外の生メッセージ・秘密値は転送しない（§20.6）。

### 26.1 優先度: 高

**H1. TodoWrite（軽量な進捗リスト）**
- 実装・検証結果は [docs/h1-progress.md](docs/h1-progress.md)。
- `TodoWrite({todos: [{content, status: "pending"|"in_progress"|"completed"}]})` を全文置換で受け取る。副作用はなく、権限は常に allow。
- §20 のタスク段階・計画項目（SubmitPlan）とは独立。ワークフローの状態・レビュー要件・差分判定に影響しない。「提案のみ」「小さな多段作業」ではこれだけで進捗を管理できる。
- 検証: Claude Code に合わせ、件数・文字数の上限は設けない。in_progress は同時に1件までをツール説明で指示し、複数でも拒否せず受け付ける。形式（status の値・content が空でない）の違反だけ修正可能なエラーで返す。リストは会話欄とレシートに表示し、セッション履歴に保存して再開で復元する。子エージェントは自分の分を持ち、親には混ぜない。

**H2. 環境診断とエラーの構造化**
- 実装・検証結果は [docs/h2-progress.md](docs/h2-progress.md)。
- 起動時（セッション開始時に1回）に `rg` / `pwsh` / `git` の有無と、作業フォルダの存在・読み書き権限を確認する。結果は画面に警告として出し、system には固定の短い一文だけ加える。system はセッションの最初に固定する（§24）。
- `rg` が無い場合、Grep / Glob は Node 実装へ自動で切り替える（ツールの名前・引数は変えない。`.gitignore` を尊重し、Grep は既定250件で打ち切る）。`pwsh` が無い場合は Bash の説明に原因を返す。
- ツールの失敗を `{kind, message}` の固定の種別（`missing_cli` / `not_found` / `denied` / `timeout` / `aborted` / `invalid_args` / `failed`）で扱い、レシートにも種別を残す。
- 同じツール・同じ種別の失敗が同一ターンで3回続いたら、継続せず AskUserQuestion 相当でユーザーへ取り次ぐ（`workflow_stalled` と同様に、未完了の作業は完了扱いにしない）。

**H3. Bash のバックグラウンド実行**
- 実装・検証結果は [docs/h3-progress.md](docs/h3-progress.md)。
- Windowsの起動経路の追加検証と追跡方針（2026-10-03、ユーザー承認）は [docs/h3-job-investigation.md](docs/h3-job-investigation.md)。WindowsApps版pwshでは子がJobを継承しない場合があるため、バックグラウンドの非修飾Start-Processをプロキシ化し、戻り値の子PIDを捕捉して同じJobへ明示登録する。PassThruを内部で有効にし、利用者が指定しなければ戻り値は出力しない。登録失敗時は取得できたハンドルで子の終了を試み、固定エラーで親も終了する。昇格・別ユーザー等によりプロセスアクセス権限がない場合は、子の終了も保証できない。
- 終了保証はJobに所属したプロセスと、Start-Processプロキシで捕捉した子に限る。直接のProcess.Start、モジュール名付きStart-Process、プロキシの上書き、外部ブローカー経由、登録前に生成されたJob外の子孫は追跡対象外で、終了を保証しない。バックグラウンドでは非修飾Start-Processを使うようBashの説明にも明記する。プロキシは任意コマンドを隔離するセキュリティ境界ではない。
- `Bash` に `run_in_background: true` を追加する。起動すると `shellId` を返し、待たない。`BashOutput({shellId, wait?, timeoutSec?})`（前回以降の出力と状態。待機は最大60秒）と `KillShell({shellId})` を新設する。
- 同時実行は5件まで（Claude Code に件数の上限はないが、Windows の資源を守る XHarness 独自の安全弁）。BashOutput が1回に返す出力は30,000文字（Claude Code の `BASH_MAX_OUTPUT_LENGTH` 既定値）で、超過分は先頭と末尾を残して中略し、未取得分は次の BashOutput で続きを返す。保持する出力は1件につき直近1 MB。ターンの終了・停止・セッション終了で管理対象のプロセスツリーごと終了する（MCP の stdio と同じ後片付け。上記の追跡外の起動経路は除く）。次のターンへの持ち越しはしない。
- 権限は通常の Bash と同じ gate を起動時に通す。BashOutput / KillShell は自分が起動した shellId のみ操作でき、allow。出力は秘密値のマスクを通す。
- 同時に、通常の Bash の既定タイムアウトを明示し（既定120秒、上限600秒）、時間切れは `timeout` 種別で返す。

**H4. ファイル変更の巻き戻し（チェックポイント）**
- ターンの最初の書き込み（Edit / Write）の直前に、対象ファイルの変更前の内容を `~/.xharness/checkpoints/<sessionId>/<turn>/` へ保存する（新規作成は「存在しなかった」記録）。リポジトリの外に置き、git の状態には触れない。
- `/undo` は直近のターン、`/rewind <n>` は n ターン前までの変更を戻す。戻す前に対象ファイルの一覧と、チェックポイント後にユーザー・外部が変更したファイル（内容の不一致）を示し、確認する。不一致のファイルは既定で戻さない。
- Bash による変更は追跡しない（範囲外）。画面にもその旨を表示する。worktree の worker は worktree ごと破棄できるため対象外。
- 保存期間は Claude Code の `cleanupPeriodDays` 既定値に合わせて30日（設定 `checkpoints.retentionDays` で変更可）。期限切れとセッション削除の際に削除する。ターン数・容量の上限は設けないが、1ファイル10 MB超は退避せず、そのファイルは巻き戻せないと画面に表示する。
- 戻す対象の選び方も Claude Code に合わせ、コード・会話・両方から選ぶ（既定はコードのみ。会話を戻すのは履歴の追記に「巻き戻し」を記録し、元の履歴は消さない）。
- 実装・検証結果は [docs/h4-progress.md](docs/h4-progress.md)。保存期間はユーザーの `~/.xharness/config.yaml` で設定する。秘密・保護ファイルと秘密値を含む内容は保存せず、復元不可を表示する。M3の記録は [docs/m3-progress.md](docs/m3-progress.md)、M1は [docs/m1-progress.md](docs/m1-progress.md)、M2は [docs/m2-progress.md](docs/m2-progress.md)、M4は [docs/m4-progress.md](docs/m4-progress.md)、M5は [docs/m5-progress.md](docs/m5-progress.md)。

### 26.2 優先度: 中

**M1. 画像入力と Read の画像対応**
- 画像の省略は§24の圧縮境界でのみ行う。圧縮で置き換わる範囲は要約のみを再送し、元の保存履歴は画像本体を保持する。圧縮前や未圧縮の末尾の接頭辞は変更しない。設定 `images: {maxPerMessage: 5, warnSessionBytes: 20971520}`。添付は最大5枚、保存会話中の画像合計20 MB超で画面に /compact を促す警告を表示し、強制しない。値はユーザー設定で変更できる。圧縮しても保存画像の合計は減らない。
- Codexの画像入りfunction_call_outputは実通信未確認。[docs/phase0-findings.md](docs/phase0-findings.md)のテキスト結果の往復は画像配列の受理を裏付けない。設定 `providers.codex.toolImageMode: output | user_message`（既定output）で、画像だけを後続userメッセージへ分離する退路を用意する。両方式とも変換テストのみ確認済み。確認手順は [docs/m-codex-image-local-check.md](docs/m-codex-image-local-check.md)。
- Read は png / jpg / gif / webp を画像ブロック（§5）で返す（XHarnessは1枚あたり5 MB・長辺8000pxを上限とし、超過は縮小せずエラー。2026-10-03の公式Vision資料では直接のClaude APIはbase64換算10 MBで、設計時の5 MBとは異なるが、XHarnessの上限は維持する）。入力欄への貼り付け・ドラッグでも添付できる。
- 内部形式と各 Provider の変換は対応済みのため、変換の単体テストに画像ケースを足す。画像を扱えないモデルでは添付時に画面で警告する。レシート・レポートでは画像本体を埋め込まず、種別とサイズだけ出す。
- 実装済み（2026-10-03）。Readの画像結果を文字列に切り詰めず、ToolOutputからtool_resultの画像ブロックへ接続した。Codexのfunction_call_outputへの画像配列の変換を実装したが、実通信は未確認。入力欄はプレビュー・削除・画像のみの送信・送信拒否時の復元に対応する。カタログの `imageInput: false` は非対応、未指定は未確認として警告する。未実測のモデルに対応済みとは記載しない。保存会話は画像本体を保持し、レシート・トレース・HTMLは形式とバイト数だけ記録する。詳細は [docs/m1-progress.md](docs/m1-progress.md)。

**M2. スラッシュコマンドの体系**
- 組み込み: `/clear`（新しい会話。履歴は残す）・`/resume`（履歴から再開）・`/model`・`/cost`（通信回数と使用量。M3 と連動）・`/init`（AGENTS.md の雛形を作業フォルダへ作成。既存は上書きしない）に、既存の `/mode` `/stop` `/compact` `/mcp` を加えて、入力欄の補完に一覧する。
- ユーザー定義: `<project>/.xharness/commands/*.md` と `~/.xharness/commands/*.md` を `/<ファイル名>` として展開する（本文が user メッセージになる。`$ARGUMENTS` を置換）。プロジェクト側はワークスペースの信頼（§9）の対象とし、信頼するまで一覧に出さない。
- 実装済み（2026-10-03）。`/resume`と`/model`は引数なしで一覧、引数ありで選択する。`/cost`はM3の実通信／模擬通信の回数と、親・子の取得済みレシートのトークン合計を表示する。金額・未取得使用量は推測しない。`/init`は排他的な新規作成で既存のAGENTS.mdを保持し、読み取り専用・planでは作成しない。同名の定義は信頼済みプロジェクトがユーザー定義より優先し、組み込み・MCP名は上書きしない。展開は1回だけで、本文をコマンドとして再解釈しない。信頼確認は通常の送信時に既存のワークスペース確認で行う。headlessの信頼は既存の保存済み承認を使う。詳細は [docs/m2-progress.md](docs/m2-progress.md)。

**M3. 通信回数と予算の上限**
- 設定 `limits: {llmCallsPerTurn: 0, llmCallsPerSession: 0}`（0 = 無効が既定。Claude Code の `--max-turns` / `--max-budget-usd` も既定は無制限で、利用者が指定したときだけ効く方式に合わせる）。進展のない通信の防止は、既定で有効な §20.6 の継続停止と §8 の最大ステップ数（100）が担う。`llmCallsPerTurn` は §8 の最大ステップ数と別に、再試行・圧縮・子を含む実際の通信回数を数える。超えたら `budget_exceeded` で停止し、ユーザーの入力を待つ。
- UsagePopover に今ターン・セッションの通信回数を出す。枠の残量が少ないときの警告は、取得できているヘッダの範囲で出す（推測しない）。
- 実装済み（2026-10-03）。上限はユーザーの `~/.xharness/config.yaml` から読み、リポジトリの設定では変更しない。送信直前に数え、許可した最後の通信は完了できる。次の送信を拒否した時点で親・子を停止する。セッションの累計は会話の巻き戻しやアプリの再起動でも減らない。FakeProviderの模擬通信は別の内訳を表示する。詳細と検証結果は [docs/m3-progress.md](docs/m3-progress.md)。

**M4. 編集の補助**
- レビュー修正（2026-10-03）：Read・Edit・MultiEdit・既存Writeはfatal UTF-8検査を行い、UTF-16・NUL入り・不正UTF-8を変更せず拒否する。Readも拒否し、文字化けした日本語を元に編集する事故を避ける。画像Read・新規Writeは従来の経路を使用する。
- Edit / Write は既存ファイルの最初の改行コード（CRLF / LF）と BOM を保持する。既存ファイルに改行がない場合のWriteは入力の改行を変換しない。新規ファイルは同種のファイルから推定せずLF、ただし `.bat` / `.cmd` はCRLFで作る。
- `MultiEdit({path, edits: [{old, new}]})`: 同一ファイルの複数置換を原子的に適用（1件でも失敗したら全体を書かない）。Edit と同じ権限・チェックポイントを通る。
- `NotebookEdit` は需要を見て判断する。今回は実装しない。
- 実装済み（2026-10-03）。UTF-8 BOMを保持し、既存ファイルの先頭にある改行へ置換入力を合わせる。混在ファイルのEdit／MultiEditは未編集部分の改行を変えない。Writeは先頭の改行へ統一する。レビュー後は、改行がない既存ファイルへのWriteは入力の改行を保持する。新規ファイルはLF、.bat/.cmdはCRLFを使う。MultiEditは指定順に置換し、各oldが直前の結果に1回だけ一致することを確認する。全件の成功後、同じフォルダの一時ファイルからrenameする。Editの権限ルールもMultiEditに適用し、plan・子の対象ファイル制限・チェックポイント・差分・レビューへ接続した。詳細は [docs/m4-progress.md](docs/m4-progress.md)。

**M5. AskUserQuestion の選択ボタン**
- 候補がある質問は、番号入力に加えて画面に選択ボタンを出す。押すと入力欄から同じ文章を送るのと同じ扱い（LLM へは通常の返答）。headless では従来どおり番号入力。
- 実装済み（2026-10-03）。成功したAskUserQuestionの質問・2〜5件の候補を通常の会話欄に表示し、候補の本文を入力欄と同じsend経路で送る。保存会話から再開した場合も表示する。最新の未回答の質問だけ操作でき、実行中・承認待ち・巻き戻し待ち・送信中・回答済みでは無効にする。失敗した送信は再選択できる。子の履歴では親へ誤送信しないよう選択を無効にし、子のセッション自体を再開しない既存仕様を保つ。詳細は [docs/m5-progress.md](docs/m5-progress.md)。

### 26.3 優先度: 低

- L1・L2 の設定例は実装済み（2026-10-03）。[docs/examples/README.md](docs/examples/README.md) に導入方法と制約、[docs/low-review-progress.md](docs/low-review-progress.md) にオフライン検証とL3・L4の保留理由を記録した。サンプルは自動適用せず、system・専用ツールは変更していない。
- **L1. フックのサンプル同梱**: PreToolUse でのブロック、Edit / Write 後の自動フォーマットなどの設定例を docs/examples に追加する（実装変更なし。§19.10 の入り口の範囲）。
- **L2. git 手順**: コミット・PR 作成の方針を system に足さず、`/commit` などのユーザー定義コマンド（M2）の例として docs/examples に置く。専用ツールは作らない。
- **L3. 子エージェントの文脈の引き継ぎ**: 実装済み（2026-10-03、ユーザー指示）。TaskHistoryで同じ親の完了／質問待ちの子を選び、Task.previousChildIdで新しいpromptへ最終結果・質問を参考データとして添える。直近32件・結果6,000文字＋質問合計2,000文字をメモリに保持。秘密マスクを適用し、別親・実行中・失敗／中断した子は選べない。会話や権限は再開せず、親runtime終了時に一覧を破棄する。
- **L4. 定期実行・イベント待ち（Monitor / cron 相当）**: 実装済み（2026-10-03、ユーザー指示）。アプリ起動中のユーザーコマンド /schedule after|every|idle|event と /signal、一覧・取消を追加。1会話5件／全体20件・7日有効、定期は最低60秒／最大20回。予約は永続化せず起動時に復旧しない。発火時は既存send経路のモデル・権限・上限を適用し、実行中は待機、重複・catch-up送信・失敗の自動再試行なし。停止・会話終了／削除・アプリ終了・失敗ターンで予約を取消。OSサービス・外部イベント接続は作らない。詳細と利用方法は [docs/delegation-and-schedules.md](docs/delegation-and-schedules.md)。

### 26.4 実装の順序と完了条件

H2 → H1 → H3 → H4 → M3 → M1 → M2 → M4 → M5 → L1〜L3。H2 を先にするのは、他の単位の失敗表示が H2 の種別を使うため。各単位の完了条件は、単体テスト・typecheck・lint・build の成功と、記録（docs/ に進捗ファイルを作り、未確認事項と手元で必要な確認を書く）。

**実装前に確認する未決事項**
規定値は Claude Code の仕様に合わせて決めた（2026-10-02、ユーザー指示）。ただし値は設計者の知識によるもので、公式ドキュメントでの再確認が済んでいない。実装前に確認し、違えばここを直す。
1. H4（公式資料確認済み、2026-10-03）: [Claude Code公式チェックポイント資料](https://code.claude.com/docs/en/checkpointing)で保存30日・Bashの変更は追跡しないこと・コード／会話／両方の復元を確認した。現在の同資料は最大100チェックポイントとするが、XHarnessは本節の指定どおりターン数・総容量を制限しない。外部変更の不一致を検出して既定で除外することと1ファイル10 MB上限も独自仕様。
2. H2（公式資料確認済み、2026-10-02）: [Claude Code公式ツール資料](https://code.claude.com/docs/en/tools-reference#grep-tool-behavior)でGrepの`.gitignore`尊重を確認した。同資料ではGrepの250件上限を確認できず、Globは既定では`.gitignore`を尊重しないと記載されている。XHarnessでは本節の指定どおり、両検索で`.gitignore`を尊重し、Grepを250件で打ち切る独自の規定値として実装する。
3. M3（公式資料確認済み、2026-10-03）: [Claude Code公式CLI資料](https://code.claude.com/docs/en/cli-reference)で `--max-turns` の既定が無制限、`--max-budget-usd` が指定時に上限を設け子エージェントの使用額を含むことを確認した。XHarnessは本節の指定どおり通信の試行回数を上限とし、金額への換算は行わない。
4. M4（公式資料確認、2026-10-03）: [公式ツール資料](https://code.claude.com/docs/en/tools-reference#edit-tool-behavior)では改行・BOM保持の完全な保証を確認できなかった。[公式変更履歴](https://code.claude.com/docs/en/changelog#2-1-89)にはWindowsのEdit/WriteでCRLFが二重化する不具合の修正がある。XHarnessは本節の指定どおり、新規LF・既存の改行とUTF-8 BOM保持を実装する。Claude Codeとの完全な一致とは断定しない。
5. H3（公式資料確認済み、2026-10-02）: [公式環境変数資料](https://code.claude.com/docs/en/env-vars)で、通常のBashの既定120秒・上限600秒と、出力30,000文字を確認した。XHarnessのバックグラウンドはターン終了までを寿命とし、timeoutSecを明示した場合だけその上限でも終了する。
