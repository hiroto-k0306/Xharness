# Phase 5 手元確認結果

確認日: 2026-10-02。Windows build 26200、`codex/phase5-runtime`。普段の設定・履歴と分離した `.out/phase5-local-check` / `.out/phase5-local-project` を使用した。コミット・プッシュ先は同ブランチで、main にはマージしていない。

## 確認済み

| 範囲             | 結果・確認方法                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 自動テスト       | Vitest **53ファイル・448件成功、skip 0**。Windows PowerShell 依存の試験を含む。                                                                                                                                                                              |
| 静的検査とビルド | typecheck / lint / build:headless / package 成功。package 内で Electron build も成功。`git diff --check` 成功。                                                                                                                                              |
| パッケージ       | NSIS と portable を生成。portable をリポジトリ外の `D:\AIwork\XHarness-check-phase5-20261002` にコピーし、起動・終了・再起動を確認。NSIS のインストール操作は未実施。package.json の author 未設定の警告あり。                                               |
| 画面             | ロゴ・同梱フォント・日本語・OS ボタン・FAKE 表示を確認。model / act の光る枠、gate の黄色い待機枠を確認。起動瞬間のちらつきや動画としての回転周期は評価していない。                                                                                          |
| workflow         | portable の `--fake` で計画 y 承認 → worker Read n 拒否 → Write y 許可 → ReportDone → Sonnet reviewer → 3段階完了・統合1/1を確認。別の実行では Write の a 許可も操作した。合成応答であり、モデル品質の評価ではない。                                         |
| 計画の却下・修正 | 新規セッションで n 却下と e 修正指示を個別に操作。承認欄が閉じ、入力可能になり、e では修正指示の通知が出ることを確認。                                                                                                                                       |
| AgentsPanel      | main / worker / reviewer の選択で、Transcript・StepTabs・LoopFlow のモデルと周回数が切り替わることを確認。worker はツールカード、reviewer は独立した差分入力と `[]` を表示。親の会話と混ざらない。                                                           |
| モデル切替       | Ctrl+M から Luna / high を選び、このセッションへ適用。親のモデル表示が変わり、Ctrl+N の新規セッションは元の fake のまま。修正版では fake の初期選択も Opus / high の表示と適用対象が一致。既定保存の分離は自動テストで確認、今回の画面での保存操作は未実施。 |
| シェルフック     | 確認用プロジェクトの before:model `Write-Output local-check-ok` の全文を初回承認欄に表示。y 許可後、PowerShell 実行と provider:hook レシートを確認。worker / reviewer にも実行され、同じ実行内で承認を繰り返さない。                                         |
| セッション終了   | main の Read 権限待ちで Ctrl+W。確認欄が消え、一覧の ask / running が解消。履歴は再起動後も残る。                                                                                                                                                            |
| アプリ終了       | worker の Read 権限待ちで OS の閉じるボタンを操作。再起動して ask / running が残らない。保存レシートでも子と親の aborted、および Read の deny を確認。                                                                                                       |
| WebFetch         | 実際に `https://example.com/` を取得。DNS / TLS / 本文取得が成功し、外部コンテンツの注記を確認。localhost・private IP・リダイレクト拒否は自動テストの確認範囲。                                                                                              |
| 秘密情報         | ソース・fixture・main bundle 等256ファイルをローカル秘密値とメモリ内で照合し、一致0件。対象の検索 fixture に禁止ヘッダ0件。資格情報は変更していない。                                                                                                        |

修正版 portable の SHA256:

`F86E5D33977FAB4F6FF456B716AD82AE7BA2DE820DF882010C916919F2A2B716`

## 実 API

- **Codex Luna: 1回、HTTP 200。** ChildRunner の read-only reviewer として、`add(a,b)` が `a-b` を返す小さなコードを提示。JSON の ReviewFinding を正常に読み取り、add.ts の must 指摘1件を得た。子の実通信・完了・保存と、明白な不具合の検出だけを確認した。実プロジェクト全体のレビュー品質は未評価。
- **Claude: 0回。** 読み取り専用の資格情報確認で、期限切れまたは利用不可として止まった。Haiku explorer の Read 往復は未実施。公式 CLI の更新や自前 refresh は行っていない。
- 既存の Phase 3 予算台帳を継続し、Codex は **3/12枠**、Claude は **5/7枠予約済み**（公式 CLI 試行分を含む保守的な計数）。今回の WebFetch はモデル API の送信回数に含めない。再試行・fallback による追加送信はしていない。
- 補助報告は無視対象の `.out/phase5-live-check.json` / `.out/phase5-webfetch-check.json` に保存。秘密値は報告に含めない。

## 発見して修正したこと

1. 子の履歴を Transcript に変換すると、明示的に拒否した Read が `error` になっていた。ハーネスの拒否結果を `denied` と復元するよう修正。通常のツールエラー・成功と区別する3件のテストを追加し、修正版 portable の worker カードで `denied` を再確認した。中断によるエラーはこの変換の対象外。
2. fake などカタログに無い現在モデルで ModelPicker を開くと、画面には Opus が見える一方、内部選択は fake のままで適用が無効だった。表示と内部選択を揃え、対応しない effort も表示した既定値を送るよう修正。テスト1件と修正版 portable の目視で確認。
3. 全テストの同時実行で、PowerShell フック完了待ちが一度4秒でタイムアウトした。単独実行は成功。該当試験の完了待ちを10秒、試験全体を30秒にし、全448件を再実行して成功。実装のフック timeoutSec は変更していない。

## 残る確認と制限

- Claude の公式 CLI の認証状態を復旧した後、Haiku explorer の Read 往復を最大2送信で確認する必要がある。秘密値の貼り付けは不要。
- IME の実際の変換確定 Enter、720px 実ウィンドウで新しい workflow / ModelPicker の全操作、タイトルバーのドラッグは未確認。操作ツールのドラッグで幅や位置が変わらず、成功扱いにしていない。
- ネイティブ folder ダイアログが開くことまでは確認。操作ツールがダイアログの入力欄を安定して扱えなかったため、パス選択は未確認。フック確認用フォルダは Controller の通常コマンドで事前登録し、`--resume` で起動した。
- 計画担当・effort の画面編集、既定モデル保存、PhaseBar のジャンプ・手動変更は今回の native 操作では未実施。自動テストは成功。
- 長い実会話の圧縮品質、OAuth での最大入力、実429の画面、外部 Git 認証・ネットワーク中断・競合のマージ UI、NSIS インストール・アンインストールは未実施。大量入力や429を作るための追加通信はしていない。
- 別PCの `docs/design-websearch.md` 原文は取得できていないため、暫定 §22 との照合は未完了。
- worker の並列数拡張、workflow の自動再開、worktree 片付け UI は実装の残項目であり、人間の目視確認だけでは完了しない。

今回の変更に新しい設計上の例外はない。普段の設定・会話履歴を変更せず、確認用の履歴と作業物は残した。main へのマージはしていない。
