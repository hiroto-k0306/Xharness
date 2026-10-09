> **旧版・履歴資料（2026-10-09整理）**：現行仕様として使用しない。記載されたリビジョン・環境での記録です。現行仕様は [SPEC.md](../../SPEC.md)、移動対応は [Old索引](../README.md) を参照。

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

## レビュー指摘への対応

- **既定モデル**: `src/main/config/config.ts`。`--model`(`--effort`)> `<home>/config.yaml` の `main.model` / `main.effort`(`provider:alias`・別名・モデル ID)> `claude:opus` / `high`。不正な値は警告つきで既定へ戻し、`--model` / `--effort` が解決できないときは起動時にエラーダイアログで止める。Codex は Phase 3 までは既定に戻す。`--fake` は設定ファイルを読まない。プロジェクトの `.xharness/config.yaml` とのマージは Phase 4。以前の開発用既定(Haiku)は変わるので、確認時は `--model haiku` を付ける。
- **セッションごとのモデル**: モデルと effort を `index.json` の各セッションに保存し、`set_model`(`sessionId` 必須)はそのセッションだけに効く。Agent Loop に `current()` を足し、各周の STEP 1 で最新のモデルを読むため、実行中の呼び出しは中断せず次の周から反映される。実行中の `set_model` がターン終了時の保存で巻き戻らないようにした。旧い索引はメモリ上で既定値を補う。
- **cwd の確認**(§18.4): 送信・再開・新規作成の各時点で、作業フォルダが存在するフォルダかを確認する。無いときはモデルもツールも動かさず、画面に通知する(再開時は履歴は表示し、通知だけ出す)。
- **権限待ちの解放**: `close_session`(Ctrl+W)とアプリ終了(`before-quit` → `SessionController.shutdown()`)で、待ちを deny で解決してターンを中断し、履歴の保存まで待つ(最大3秒)。tool_use には必ず tool_result が付いて保存される。

## レビュー(2回目)への対応

- **索引の保存**: `JsonFile`(`src/main/session/store.ts`)で書き込みを直列化し、一時ファイル名を書き込みごとに一意にした。Windows で rename が EPERM / EBUSY / EACCES のときは短く待って最大4回再試行する。同時に20件保存しても失敗・欠落がないことを試験した。
- **壊れた索引**: JSON として読めない、または配列でない `index.json` / `workspaces.json` は上書きせず `.corrupt-<時刻>.bak` へ退避し、空の一覧で始める。退避したことは最初に開いた(作った)セッションへ通知する。
- **二重送信**: `send` は作業フォルダ確認の前に同期的に実行中へ切り替え(予約)、フォルダが無ければ予約を戻す。履歴の読み込みも1回にまとめ、遅れて届いた読み込みが進行中の履歴を巻き戻さないようにした。
- **送信を断られたとき**: 入力欄に文を戻す(その間に打った文は上書きしない)。main が理由を通知済みの失敗(作業フォルダが無いなど)は、画面側で英語の通知を重ねない。
- **DevTools**: 開発起動では常に、パッケージ版は `--devtools` を付けたときだけ開く。
- **二重起動**: 2つ目は終了し、既存のウィンドウを前面に出す。
- **headless `--fake`**: fixtures をスクリプトの場所から探す(`--fixtures` で指定も可)。リポジトリ外から `node dist/headless.js --fake` で動くことを確認した。
- **git 状態**: ワークスペースのブランチ読み取りを2秒キャッシュする。
- 未対応: `postinstall` で Electron の install.js を直接呼ぶ回避策の根本原因(pnpm の build 許可がなぜ効かなかったか)は、Windows の再現環境がないため調べていない。install.js はバイナリがあれば何もしないので、残しても害はない。
