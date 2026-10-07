# 逆方向の実通信検証（Codex計画 → Codex実装 → 独立テスト → Claudeレビュー）2026-10-07

ユーザー承認の実通信検証。

- 確認済みのHEADは `6932f8d`。
- 配布物のソースは `6a5c02f95aa1af8b2335c550133fad0409835991`（`dist/win-unpacked`。`XHarness.exe` `e44d2b47…c719`、`app.asar` `dbdd96b0…9270`）。

## 条件

- 製品：配布物（packaged）を `--official-only` で起動し、公式workflowパネルを使った。
- プロファイル：隔離した `%TEMP%\xh-reverse-home-b5f8e9`。Codex実行パス・workspace保存先・メインモデルは、この中でだけ設定した。
- workspace保存先：`D:\AIwork\xh-reverse-b5f8e9`
- 実際のworkspace：`D:\AIwork\xh-reverse-b5f8e9\76c18d6d-fbdf-454e-aae0-fabf5145decc\workspace-sba1Al`
- 環境：`codex-cli 0.160.1`。PATHの先頭はStore版pwsh。
- 通信上限：Codexの計画1回・Codexの実装1回・Claudeのレビュー1回。失敗・拒否・修正指摘が出たら停止し、再試行しない。
- 補助スクリプト（`.out/reverse-live.mjs`、未コミット）は承認ボタンを押さない。計画は利用者が画面で承認した。
- 承認前に提示したtrusted・ACLの変更は、ユーザーが承認した。

## 結果

| 段階               | モデル・effort                                                                           | 結果                                                                                                      | In / Out                |
| ------------------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------- |
| 計画（Codex）      | `gpt-6-luna` / low（メインモデル。選択キー `gpt-6-luna`、カタログv1 digest `874e3595…`） | 完了。5.9秒                                                                                               | 10,571（cached 0）/ 170 |
| 計画承認           | —                                                                                        | 01:04:45に利用者が画面で承認。digest `fd634ce2…f0334`                                                     | —                       |
| 実装（Codex）      | `gpt-6.1-sol` / low（計画が選択）                                                        | **失敗**。7.3秒。最初の操作要求を安全判定が拒否（`program: shell-wrapper`）。個別承認画面には届いていない | 欠測（`usage=null`）    |
| 独立テスト         | —                                                                                        | 未実施（実装失敗で停止）                                                                                  | —                       |
| レビュー（Claude） | `claude-sonnet-5-5` / low（計画が選択）                                                  | 未実施。通信0回                                                                                           | —                       |

計画の内容は次のとおり。

- 作業：`add.mjs` の足し算を直し、テストは変更しない。
- 変更してよいファイル：`add.mjs` だけ。
- 合格条件：`arithmetic`。
- 実装担当とレビュー担当は別会社。

通信回数は、Codex 2回（計画1・実装1）、Claude 0回。製品が記録するのはphase呼出の回数で、SDK・App Server内部のHTTP往復数は欠測。

### 拒否された操作

```
"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content add.mjs; rg --files -g '*test*' -g 'package.json' -g 'AGENTS.md' -g '*contract*'"
```

中身が二重引用符で囲まれ、`;` で2つのコマンドをつなぎ、`rg` を含む。SPEC §15の許可対象（計画したファイル1件へのGet-Content、または登録テスト）の外で、ラッパーの完全一致形にも当たらない。現行の仕様どおりの正しい拒否で、誤判定ではない。

- 実行されたコマンドは0件。
- `add.mjs` は未変更（`a - b` のまま、HEAD=base）。
- コミット・テスト・レビューは0件。
- テスト対象・レビュー対象のコミットはない。

## 設定・権限・後片付け

- trusted登録：`~/.codex/config.toml` に `[projects.'d:\aiwork\xh-reverse-b5f8e9\76c18d6d-fbdf-454e-aae0-fabf5145decc\workspace-sba1al']` が1件追加された（15件→16件）。削除は未実施で、ユーザーの指示待ち。
- ACL：コマンドが実行されず、Codexのsandbox setupが動いていない（sandboxログに記録なし）。workspaceに明示ACEは付いていない。
- 削除したもの：workspace（`.git`・`acceptance.test.mjs`・`add.mjs`）と空になった親フォルダ、隔離プロファイル。
- 保持した証跡（workspaceの外）：`D:\AIwork\xh-reverse-b5f8e9\evidence\` の `trial.json`（状態の推移）、製品の `workflow.json`、`report.html`、`workspace.json`。

## 未確認・残る課題

- Codex実装からClaudeレビューまでの逆方向の通しは、未確認。
- 実装役のCodexは、探索で複合コマンドや `rg` を使おうとするため、現在の許可対象（Get-Contentのみ）では止まりやすい。完了させるには、Codexへの指示で操作を絞るか、許可対象を見直す必要がある。どちらも仕様変更なので、要承認。
