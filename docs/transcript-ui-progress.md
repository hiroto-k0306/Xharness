# 会話欄の改善と出力上限の修正（2026-10-03）

PR #9（codex/transcript-collapse-agents-bar）と PR #10（codex/notice-newline-zoom-focus）の記録。ユーザー要望に基づく。仕様は DESIGN.md §16・§19.6・STEP 2 の失敗表・§20.3・M1 に反映済み。

## 入った変更

| 内容                                                                                                                                                                                                                            | 主な場所                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 応答の文字は空白までためて送るが、ツール呼び出しの前にためた分を送り切る（日本語の応答がツールカードの前後で途切れていた）                                                                                                      | `src/main/session/turn-events.ts`                                      |
| ツールカードを標準で閉じた1行表示にし、クリックで入力の全文を開閉（Bash はコマンド、ほかは整形 JSON、4000文字で省略）                                                                                                           | `src/shared/summary.ts`、`src/renderer/components/Transcript.tsx`      |
| 右の Agents 列をなくし、Hero の `▸ overview` の右側に横並びで表示                                                                                                                                                               | `src/renderer/components/AgentsPanel.tsx`、`Activity.tsx`、`App.tsx`   |
| 自動追従のときも会話欄は main のまま。STEP 表示と LoopFlow だけを動いているエージェントに追従。手で選んだエージェントに出力がなければ案内文を出す                                                                               | `src/renderer/App.tsx`                                                 |
| Claude の出力上限（`max_tokens`）で閉じていないブロックが残っても protocol エラーにせず、text だけ残して tool_use・thinking を捨て、既存の「Continue.」で続ける。既定 `max_tokens` を 4096 → 32000                              | `src/main/providers/claude/stream.ts`、`convert.ts`                    |
| ワークフロー完了（または往復上限）後に、main が最終報告を書く1ラウンドを与えてから止める。報告ラウンドが通信失敗・中断した場合はその理由を維持する。チャットに項目一覧つきの完了通知を出す                                      | `src/main/workflow/runtime.ts`、`src/main/session/workflow-factory.ts` |
| 画像入力の「未確認」表示をやめ、`imageInput: false` のモデルだけ警告する                                                                                                                                                        | `src/renderer/components/PromptLine.tsx`                               |
| 会話欄の添付画像をクリックで拡大。Esc・背景・閉じるボタンで閉じる。開いている間はフォーカスを閉じるボタンにとどめ、キーを背後のショートカット（承認の y / a / n、Esc 中断）へ伝えない。閉じると元の画像ボタンへフォーカスを戻す | `src/renderer/components/Transcript.tsx`                               |
| 複数行の通知（完了通知の項目一覧）の改行を保持する                                                                                                                                                                              | `src/renderer/components/Transcript.module.css`                        |

### 「Claude protocol failed」の原因

実アプリのトレース（`~/.xharness/traces/`、2026-10-03T20:05:35Z と 20:25:27Z）で確認した。Opus 5.5 の応答が `max_tokens: 4096`（うち thinking 1282）で打ち切られ、tool_use（SubmitPlan / 長い編集）の `content_block_stop` が来ないまま `message_delta`（`stop_reason: max_tokens`）が届いた。デコーダがこれを不正な順序として例外にし、adapter が `Claude protocol failed`（画面: 応答を解釈できませんでした）にしていた。再現用 fixture: `test/fixtures/claude/max-tokens-truncated-tool-use.json`。

## 追加修正（2026-10-04、レビューの should 対応）

- **拡大表示中のプログラムによるフォーカス移動**: 実行終了時に PromptLine が `textarea.focus()` を呼ぶと、背景の入力欄へフォーカスが移り、文字が入りうる指摘を修正。拡大中だけ `focusin` を捕捉し、閉じるボタン以外へ移ったら同期的に引き戻す。閉じるとき・アンマウント時にはリスナーを解除してから元の画像ボタンへフォーカスを戻す（入力欄ではなく元画像に戻す既存仕様を維持）。空の会話へ切り替わってポータルが消えた場合も拡大状態を解除する。
- 単体テストで背景の `textarea.focus()`、閉じた後の通常フォーカス、開いた状態のアンマウント後のリスナー解除、会話が空になった後のキー制御解除と拡大状態のリセットを確認。
- 実際の App・PromptLine・SessionController と待機可能な FakeProvider を使う結合テストを追加。画像を拡大したまま実行中→待機へ移っても閉じるボタンにフォーカスが残り、文字が背景へ入らず、背景に下書きがあっても Enter は拡大表示を閉じるだけで追加送信しないこと、閉じた後は通常入力できることを確認。

### 追加修正の検証

- Windows、Node 24.16.0（`C:\Program Files\nodejs\node.exe`）、pwsh 7.6.6（実体は下記と同じ WindowsApps / Store 版）。
- このシェルでは `pnpm` が PATH に無いため、インストール済み `node_modules` の各 CLI を Node で直接実行。`tsc --noEmit` / `eslint .` / `electron-vite build`: 成功。
- `vitest run --exclude=spike/.out/** --exclude=.tools/** --exclude=dist/** --maxWorkers=4`: 133 ファイル / 1022 件成功（スキップなし）。対象2ファイルのテストも27件成功。
- 既存の AskUserQuestion 結合テストでは React の重複 key 警告が出るが、テストは成功。今回のフォーカス修正の範囲外として残す。
- 修正後のインストーラーは再作成していない。実アプリでの表示・操作確認と、以下の実 API 未実測事項は引き続き未確認。

## 追加要望：完了報告と連続コマンド（2026-10-04）

- ワークフロー完了・レビュー往復上限の項目一覧つき通知に `presentation: "assistant"` を付け、main → store → Transcript で保持する。assistant の発言と同じラベル・本文装飾・改行保持で表示し、先頭の `#` は付けない。通常の通知やエラーは従来の表示を維持する。表示だけの変更で、モデル履歴へシステム報告を追加しない。
- 2件以上連続する通常のツール呼び出しを、標準で閉じた1つの「コマンド N 件」にまとめる。見出しに running / ok / error / denied の件数を出す。展開すると、従来の個別カードと入力全文を確認できる。
- 会話・通知・MCP表示・TodoWrite / AskUserQuestion の専用表示でグループを区切る。回答ボタンや進捗リストを折りたたみに隠さない。
- 先頭の呼び出しIDをキーにし、1件→複数件の増加、追加の呼び出し、結果更新でも手動の開閉状態を維持する。
- 仕様はユーザー要望に基づき DESIGN.md §16.3 を更新。テストで標準closed・展開と全文・増分更新時の状態・区切り・専用UIの可視性、通知イベントからassistant表示への変換とHTMLエスケープを確認。
- 同じWindows / Node 24.16.0 / WindowsApps版pwsh 7.6.6で、`tsc --noEmit` / `eslint .` / `electron-vite build` に成功（上記と同じNode直接実行）。全体テストは133ファイル / 1029件成功、スキップなし（`--maxWorkers=4`）。既存の重複key警告は継続する。
- 実画面の見た目・操作確認とインストーラー再作成は未実施。以前提示したインストーラーには今回の変更は含まれない。

## 未確認・未実測

- `max_tokens` で切れたあとの続行を、実 API では試していない（fixture と FakeProvider のみ）。特に、tool_use を捨てた結果 thinking だけが残った assistant メッセージを、次の要求で実 API が受け付けるかは未実測。
- 実画面での見た目（ツールカード、Agents の横並び、完了通知、拡大表示）は未確認。
- 作業中に動いていたアプリは修正前のビルドだったため、途中でも同じ protocol エラーが一度起きた（20:25:27Z）。新しいビルドでの再発有無は未確認。

## 確認環境と結果

- Windows、Node 24.16.0、pwsh 7.6.6（WindowsApps / Store 版: `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`）
- `pnpm typecheck` / `pnpm lint` / `pnpm build`: 成功
- `vitest run --maxWorkers=4`: 133 ファイル / 1018 件成功・1 件スキップ（PR #10 時点）
- 既定の並列数で全体を回すと、負荷によるタイムアウトが毎回 1〜4 件出る（失敗するテストは毎回異なり、単独や `--maxWorkers=4` では成功）。今回の変更とは無関係。
- 編集ツールでファイル名の大文字小文字が変わることがあった（`Transcript.tsx` → `transcript.tsx`）。元に戻し、git の登録名と全ファイルが一致することを確認した。
