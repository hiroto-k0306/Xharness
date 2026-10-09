> 過去の記録：移動元 `docs/reverse-live-20261007.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

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

## 対応：Codex実装への操作の絞り込み（2026-10-07、ユーザー承認の方針1）

許可範囲は広げず、Codexへの指示で操作を絞る。

### 修正

`codexDeveloperInstructions`（`src/main/workflow/official/codex.ts`）で、実装・fixのthreadの開発者指示に次を伝える。

- 承認経路に回せるコマンドを、計画と登録テストから具体的に列挙する。
  - 計画済みファイルごとの `Get-Content -Raw <file>`
  - 登録テストのコマンド
  - 1回に1コマンド
- 複合コマンド（`;` `|` `&&` `||`・部分式）と探索（rg・ls・dir・Get-ChildItem・git・cat・type）は使わない。変更するファイルは計画で既に分かっている。
- ファイル変更はファイル編集（apply_patch）で行う。
- それ以外のコマンドは拒否され、再試行なしで停止する。許可されたコマンドにも、利用者の今回限りの承認が必要な場合がある。

読み取り専用のphase（計画・レビュー・質問）の指示は従来どおり。安全判定・許可範囲・承認手順は変更していない。SPEC §15に追記した。

### 検証（オフライン）

`codex.test.ts` に1件を追加した。

- 指示に列挙したコマンドが、そのまま安全判定で通ること。Get-Contentは個別承認、登録テストは許可。
- implementのthreadにだけ列挙が渡り、reviewには渡らないこと。

official workflowの17ファイル・230件が成功した。型チェック・lintも成功した。

### 未確認

この指示でCodexが実際に操作を絞るかは、実通信で未確認。モデルが指示に従わず別の操作を要求すれば、従来どおり拒否して停止する。

## 再検証（2回目、2026-10-07 10:19〜10:21、ユーザー承認）

### 配布物と条件

- 配布物は `f3e3dfd7d1911df731701ea85676f1f5e0d89e53` から作り直した（`dist/win-unpacked`）。
  - `XHarness.exe`：SHA256 `625DA01E…C06F`
  - `app.asar`：SHA256 `FC723358…3406`
  - 列挙指示が `app.asar` に入っていることを確認した。
- 隔離プロファイル：`%TEMP%\xh-reverse-home-74109e`
- workspace：`D:\AIwork\xh-reverse-74109e\996158f9-9362-49f6-bd7d-a1e46e2a760d\workspace-qskrP6`
- 通信上限・停止条件・承認の扱いは1回目と同じ（補助スクリプト `.out/reverse-live-2.mjs`、未コミット）。

### 結果

| 段階               | モデル・effort                                                    | 結果                                                                               | In / Out                                 |
| ------------------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| 計画（Codex）      | `gpt-6-luna` / low（メインモデル。カタログv1 digest `874e3595…`） | 完了                                                                               | 11,337（cached 0）/ 172                  |
| 計画承認           | —                                                                 | 10:20:09に利用者が画面で承認。digest `3618014e…9191`                               | —                                        |
| 実装（Codex）      | `gpt-6.1-sol` / medium（計画が選択。観測モデルも同じ）            | **失敗**。88.2秒。2件目の個別操作が `binding: user-declined-or-expired` で終わった | 24,822（cached 12,160）/ 172。thread累計 |
| 独立テスト         | —                                                                 | 未実施                                                                             | —                                        |
| レビュー（Claude） | `claude-sonnet-5-5` / medium（計画が選択）                        | 未実施。通信0回                                                                    | —                                        |

通信回数は、Codex 2回（計画1・実装1）、Claude 0回。SDK・App Server内部のHTTP往復数は欠測。

### 実装中の操作

1. `"…powershell.exe" -Command 'Get-Content -Raw add.mjs'`：指示の列挙どおり。安全判定を通って個別承認に回り、利用者が許可した。終了コード0、226ms、出力は修正前の `add.mjs`。前回の失敗原因（Temp配下のcwd）はD:配下で再発していない。
2. ファイル編集（apply_patch）：計画の許可範囲で許可。`add.mjs` を `a - b` → `a + b` に変更した。
3. `"…powershell.exe" -Command 'node --test acceptance.test.mjs'`：登録テストのラッパー形で、個別承認に回った。10:20:38に要求され、承認期限の60秒後（10:21:38）に `user-declined-or-expired` で終了した。時刻からは期限切れと見られるが、記録上は拒否と期限切れを区別できない。

前回止まった探索・複合コマンドは出ていない。指示による絞り込みは今回の実装で機能した。

- 変更差分：`add.mjs` の1行だけ（未コミット）。コミットは0件で、HEAD=base `3f9e6c5`。
- テスト対象・レビュー対象のコミットはない。

### 権限・設定・後片付け

- trusted登録：1件追加（16件→17件）。`[projects.'d:\aiwork\xh-reverse-74109e\996158f9-9362-49f6-bd7d-a1e46e2a760d\workspace-qskrp6']`。1回目の `…xh-reverse-b5f8e9…workspace-sba1al` も残っている。どちらも削除は未実施で、ユーザーの指示待ち。
- ACL（sandboxログ）：
  - workspaceにsandboxグループとcapability SIDの書き込みACE、`.git` に拒否ACEが付与された。workspaceの削除とともに消えた。
  - `C:\Users\ahwri\.claude.json` への読み取りACE（CodexSandboxUsers:RX）が再付与された。この付与は2026-09-17から繰り返し記録されている既存のもので、今回新しく加わった権限ではない。ただし開始前の説明（AppDataの読み取り）には含めていなかった。
  - `D:\AIwork` のACLは変わっていない。
- 削除したもの：workspaceとその親フォルダ、隔離プロファイル。
- 保持した証跡：`D:\AIwork\xh-reverse-74109e\evidence\`
  - `trial.json`
  - 製品の `workflow.json`・`report.html`・`workspace.json`
  - `workspace-diff.txt`・`workspace-acl.txt`
  - `sandbox-log-excerpt.txt`・`claude-json-acl.txt`

### 未確認・残る課題

- 独立テストとClaudeレビューまでの通しは、まだ未確認。
- 実装中の個別承認の期限は60秒で、2件目の承認に間に合わないことがある。
- 診断の理由コードは、拒否と期限切れを分けていない。

## 対応：個別承認の期限切れ（2026-10-07、ユーザー指示）

`1cc9930` で次を変えた。

- 個別承認の期限を60秒から10分にした。
- 承認を待つ間は、phaseの制限時間（180秒）を止める。決定後に残り時間から再開する。
- 停止理由を分けて記録する。拒否は `user-declined`、期限切れは `approval-expired`、取消は `approval-cancelled`。
- 期限を過ぎた許可は、従来どおり無効。

テストは次を確認した。

- 期限の既定値が10分であること。
- 承認がphaseの制限時間より長くかかっても、timeoutにならないこと。
- 許可・拒否・期限切れ・取消のそれぞれで、停止理由が正しく記録されること。

official workflowの18ファイル・235件が成功した。型チェック・lint・formatも成功した。

## 再検証（3回目、2026-10-07 10:30〜10:32、ユーザー承認）：完了

### 配布物と条件

- 配布物は `1cc9930fc65dde58b06a122d6fd80aba4c33149f` から作り直した。
  - `XHarness.exe`：SHA256 `341FC729…99A1`
  - `app.asar`：SHA256 `2B36DA22…FB0`
- 隔離プロファイル：`%TEMP%\xh-reverse-home-077c6b`
- workspace：`D:\AIwork\xh-reverse-077c6b\c4a6713f-5830-4616-bb45-4de14a759161\workspace-DyjCb6`
- 補助スクリプト：`.out/reverse-live-3.mjs`（未コミット）。通信上限・停止条件は1・2回目と同じ。

### 結果

| 段階               | モデル・effort                                   | 結果                                                       | In / Out                                                              |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| 計画（Codex）      | `gpt-6-luna` / low（観測も同じ）                 | 完了。6.4秒                                                | 11,335（cached 0）/ 158                                               |
| 計画承認           | —                                                | 10:31:08に利用者が承認。digest `9e53a6a3…feb3`             | —                                                                     |
| 実装（Codex）      | `gpt-6.1-sol` / medium（計画が選択。観測も同じ） | 完了。45.3秒。個別承認2件を利用者が許可                    | 50,339（cached 36,864）/ 253。thread累計                              |
| 独立テスト         | —                                                | `arithmetic` 合格（exit 0、1.65秒）。対象HEAD `47b1d79`    | —                                                                     |
| レビュー（Claude） | `claude-sonnet-5-5` / medium（計画が選択）       | 完了。5.4秒。指摘0件。対象 base `00490db` → head `47b1d79` | Sonnet：In 2 + cache作成 7,591 / Out 213（思考69）。Haiku：1,471 / 13 |

通信回数は、Codex 2回（計画1・実装1）、Claude 1回（レビュー1）。上限内で、修正ループは0回。SDK・App Server内部のHTTP往復数は欠測。

### 実装中の操作

1. `"…powershell.exe" -Command 'Get-Content -Raw add.mjs'`：利用者が許可した。exit 0。
2. ファイル編集：計画の範囲内で許可。`add.mjs` を `a - b` → `a + b` に変更した。
3. `"…powershell.exe" -Command 'node --test acceptance.test.mjs'`：利用者が許可した。
   - Codexのsandbox内では `node` が見つからず、exit 1（PowerShellの「用語 'node' は…認識されません」）。
   - 合否はXHarnessの独立テストで判定しており、そちらは合格した。

探索・複合コマンドの要求は0件。

### 変更差分とコミット

- XHarnessがコミット `47b1d79`（`workflow: approved single-task change`、作者 `XHarness <xharness@local>`）を作成した。
- 差分は `add.mjs` の1行のみ（`a - b` → `a + b`）。
- テストとレビューの対象は、どちらも `47b1d79`。

### 観測した注意点

- **レビューでのHaikuの使用**：Claudeのレビュー中に `claude-haiku-4-5-20251001` の使用（1,471 / 13）がSDKの結果に記録された。
  - assistantの発言はすべて `claude-sonnet-5-5` で、Haikuの発言はない。SDK内部の補助呼び出しと見られる。
  - 指定外モデルの使用として記録した。原因は未調査。
- **sandbox内のnode**：Codexのsandbox内からは、登録テストの `node` を実行できなかった。実装役の自己テストは失敗するが、独立テストには影響しない。

### 権限・設定・後片付け

- trusted登録：1件追加（17件→18件）。`[projects.'d:\aiwork\xh-reverse-077c6b\c4a6713f-5830-4616-bb45-4de14a759161\workspace-dyjcb6']`。1・2回目の分と合わせて3件が残り、削除はユーザーの指示待ち。
- ACL：
  - workspaceに書き込みACEと `.git` の拒否ACEが付いた。workspaceの削除とともに消えた。
  - `.claude.json` への読み取りACEの再付与がログに記録された。終了後の `icacls` では、このACEは見当たらない（ファイルが書き換えられたためと見られる）。
  - `D:\AIwork` は変わっていない。
- 削除したもの：workspaceとその親フォルダ、隔離プロファイル。
- 証跡：`D:\AIwork\xh-reverse-077c6b\evidence\`（trial・workflow・report・workspace・差分・ACL・sandboxログ）。
