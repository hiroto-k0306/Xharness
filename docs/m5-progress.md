# M5：AskUserQuestionの選択ボタン

2026-10-03。DESIGN.md §26.2のM5を `codex/m3-m5-agent-features` で実装した。このブランチでM3 → M1 → M2 → M4 → M5まで完了。次はL1〜L3。実Claude / ChatGPT API通信なし、依存追加なし。

## 実装

- 成功したAskUserQuestionの質問と2〜5件の候補を、会話欄の枠と番号付きボタンで表示する。ボタンを押すと、番号ではなく候補の本文を通常の入力欄と同じ `useStore.send` → IPC `send` → SessionController経路で送る。空白のtrim、コマンドの解釈、送信可否も通常入力と同じ。LLM専用の返答APIは追加していない。
- 質問はライブのtool_callと保存済みのtool_useから同じ検証関数で復元する。文字列の長さ・件数・空の候補を検証する。pending / error / deniedの呼び出しは選択ボタンを出さない。HTMLはReactの文字列として描画し、解釈しない。既存の秘密値を除去した入力イベント・保存会話を使用する。
- 直後にユーザーメッセージがない最新の質問だけ操作できる。新しいAskUserQuestion / StopTaskがあれば以前の質問は無効。実行中・承認待ち・巻き戻し待ちにも無効にする。送信直前の同期ロックで連打を防ぎ、成功した送信は再送しない。IPCが拒否した場合や例外時はエラーを表示して再選択できる。
- セッション・表示するエージェントを切り替えたときは会話コンポーネントを切り替える。子エージェントの履歴のボタンは操作できず、親セッションへ誤って回答を送らない。子は既存仕様どおり質問で終了し、親への回答後に再委託する。子の文脈引き継ぎの補助はL3の範囲。
- 番号や自由な文での回答は引き続き入力欄で送れる。候補のない質問とheadlessの表示・番号入力は従来のまま。

## 検証

- Windows、Node 24.16.0（`C:/Program Files/nodejs/node.exe`）、WindowsApps版PowerShell 7.6.6（`C:/Users/ahwri/AppData/Local/Microsoft/WindowsApps/pwsh.exe`）をPATHの先頭へ指定した。FakeProvider・一時フォルダ・実際のSessionControllerとIPCの検証処理を使用し、実モデルへ通信していない。
- FakeProviderからAskUserQuestion → 質問の成功・ターン終了 → ボタン選択 → ユーザーメッセージ表示 → 次のProviderRequestの履歴に候補本文 → 通常応答、までApp統合テストで確認した。番号の自動置換は行わない。
- ライブと保存会話の同じ候補への復元、不正な候補、回答済み・以前の質問・StopTask後・実行中・承認等の待機中・回答先なしの無効化、連打、拒否・例外後の再選択、HTML文字列のエスケープを確認した。
- Node 24、rgあり：全113ファイル・868テスト成功。rgを含むPATHのディレクトリを外して `Get-Command rg` がないことを確認した実行：全113ファイル・867成功・rg専用1件スキップ（合計868）。
- Node 22.23.3（`.tools/node_modules/node/bin/node.exe`）：関連5ファイル・47テスト成功。
- typecheck / lint / Electron build / headless build成功。変更したコードのPrettierと `git diff --check` を確認。既存のpnpm 10.34.6による `pnpm.onlyBuiltDependencies` の配置に関する警告は継続している。依存・設定は変更していない。

## 手元で実施が必要

- 次の配布版で、長い日本語の候補の折り返し、マウス・キーボードでの選択、質問後の再起動とセッション切り替え、自由入力での回答を画面から確認する。今回はjsdomによる画面と統合テストまで。exe作成、インストール済みアプリの更新、実モデルが質問ツールを選ぶ操作は行っていない。
