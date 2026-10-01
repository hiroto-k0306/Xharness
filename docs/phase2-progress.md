# Phase 2: Electron シェルと exe 化の準備

2026-10-01。クラウド(Linux)で実装・検証した範囲。手元(Windows)での確認は [phase2-local-check.md](phase2-local-check.md)。

## 実装

- **テスト追加**: フックの `inject` が、送信済みの `tool_result` や過去メッセージを書き換えないこと(`loop-hooks.test.ts`)。
- **FakeProvider**(`src/main/providers/fake/`): fixtures の SSE を実 ClaudeAdapter と同じデコーダ(`decodeClaudeStream`)で再生する。テキスト・ツール呼び出し・429・途中切断・AbortSignal による中断を再現。明示スクリプトまたは発言のキーワードで応答を選ぶ。`headless --fake` と Electron の `--fake` で使う(どちらも資格情報を読まない)。
- **契約**(`src/shared/ipc.ts`): `UiEvent`(§16.4)、`HarnessCommand`、`parseCommand`(IPC の入力検証)。チャネルは `harness:event` / `harness:command` の2本のみ。
- **SessionController**(`src/main/session/`、electron を import しない): Agent Loop と UI の橋。セッション・ワークスペースの保存(`~/.xharness/`、§18.4)、権限確認(全ツール ask、`a` はそのセッションだけ)、中断、複数セッションの同時実行、読み取り専用セッション(書き込み系ツールを渡さない)、「その他」の scratch フォルダ(§18.5)。
- **Electron**: `src/main/index.ts`(フレームレス + `titleBarOverlay`、単一インスタンス、外部リンクは https のみ既定ブラウザ)、`src/main/ipc.ts`(送信元フレームの検証)、`src/preload/index.ts`(`window.harness` に `command` / `onEvent` だけを公開)、`src/main/security.ts`(`contextIsolation: true` / `nodeIntegration: false` / `sandbox: true`)。preload は sandbox 用に CommonJS で出力。
- **画面**(`src/renderer/`、React + Zustand + CSS Modules): TitleBar、Sidebar(ワークスペースごとのグループ + 「その他」、開閉の保存、検索、並び替え)、Transcript、PromptLine(IME の変換確定 Enter では送信しない)、PermissionInline(`y` / `a` / `n`)、StepTabs(実行中の STEP の光る枠、権限待ちは回転せず warn 色の明滅、`prefers-reduced-motion` 対応)、WorkspacePicker の folder タブ。mockup の CSS を移植し、ロゴは `brand/mark.svg`。フォントは `@fontsource` を同梱(オフライン動作)。
- **パッケージング準備**: `scripts/make-icon.ts`(`brand/icon.svg` → 16/24/32/48/64/128/256px、16・24px は影なし → `resources/icon.ico`)、`electron-builder.yml`(nsis + portable、`--fake` 用 fixtures 3件を extraResources へ)。

## 確認(クラウド)

- Vitest 210 件成功・2 件スキップ(Phase 1 時点は 107 成功・2 失敗)。スキップは `pwsh` が無い環境で除外した PowerShell 依存の2件。追加分は、jsdom の画面部品・ストア・結合(App + 実 SessionController + FakeProvider)、SessionController、IPC 検証、セキュリティ設定、アイコン生成、builder 設定。
- 型チェック・ESLint・Prettier 成功。`electron-vite build`(main / preload / renderer)成功。`build:headless` と `node dist/headless.js --help` も成功。
- `electron-builder.yml` を electron-builder 自身のスキーマ検証に通した(未知キーを足すと拒否されることも確認)。
- `out/renderer` を Chromium で開き、実 SessionController + FakeProvider につないで、空状態・WorkspacePicker・権限待ち・実行中の光る枠・中断のスクリーンショットを目視した(Electron ではない)。

## 実施していないこと・未確認

- Electron 本体の起動、`titleBarOverlay`、sandbox 下の preload 読み込み、パッケージ後の exe、インストーラ(クラウドでは実行しない)。
- 実 API への通信、`pwsh` を使う Bash / 実ファイルツールの画面経由の実行、実 CLI の資格情報。
- 以下は Phase 2 の範囲外としたため未実装: Hero・PhaseBar・LoopFlow・Receipts・UsagePopover・AgentsPanel・ModelPicker、repository タブと worktree、Markdown / コードのハイライト描画(react-markdown・Shiki)、セッションの右クリックメニュー(名前変更・複製・削除など)、タイトルの自動要約(今は最初の発言の先頭 40 文字)、Windows 通知、サイドバー幅のドラッグ、`Ctrl+H` / `Ctrl+U` / `Ctrl+M`、コマンドライン引数でのワークスペース指定、permission ルール(Phase 4)、レシートの永続化。

## 設計との差(DESIGN.md を更新済み)

- §16.4 の `UiEvent` に、同時実行のための `sessionId` と、`state` / `transcript` / `turn` / `tool_result` / `permission_resolved` を追加した(チャネルは2本のまま)。
- フォントは `resources/fonts/` ではなく `@fontsource/*` の woff2 をバンドルへ取り込む(同梱・オフライン動作は同じ)。
- `+ new session` は、今のセッションと同じワークスペースで新規セッションを作る。別のワークスペース・「ワークスペースなし」は WorkspacePicker(Ctrl+O)で選ぶ。
- `--fake` のデータは `~/.xharness-fake/` に保存し、`~/.xharness/` を汚さない。
