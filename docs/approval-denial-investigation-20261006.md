# Codex操作承認の拒否原因と修正（2026-10-06）

開始HEADは `3dd8cb0`（配布ソース `98496fb` ＋報告追記）、ブランチ `feature/official-workflow-single-task`。開始時に未コミット変更なし。worktreeは他に `review/integrated-release` と `verify/task-evaluation-main` があり、どちらにも触れていない。作業はClaude Code（Opus 5.5）が行った。push・merge・インストール済みアプリの更新はしていない。

## 結論

[前回の報告](limited-approval-model-investigation-20261006.md)で、Codexの最初の操作が個別承認UIに届かず拒否されていた原因は、承認要求の外形（envelope）の判定にあった。具体的なコマンドは前回の配布版と同じ（コマンドdigest `93edb2d0…` が一致）。

```
"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-Content -Raw add.mjs'
```

中身は計画済みファイル1件の読み取りだが、次の3つで順に止まっていた。

1. `proposedExecpolicyAmendment`（永続policy変更の**提案**）が付いているだけで拒否していた。Codex 0.160.1のプロトコル定義（`codex app-server generate-ts`でローカル生成）では、これは `acceptWithExecpolicyAmendment` で応答した場合だけ適用される。XHarnessは `accept`/`decline` しか返さないため、この拒否は誤判定だった。
2. Windows上のCodexは、モデルのコマンドを Windows PowerShell 5.1 の `-Command '…'` で包む。この形がshell wrapperとして拒否されていた。
3. 要求の `environmentId` が値を持ち、値があれば一律に拒否していた。XHarnessはthreadを `environments: []` で開始しており、応答の `thread.environments` も空（0件）だった。

## 修正（ユーザー承認 2026-10-06、A・B・B-2案1・環境案A）

- 拒否の段階（binding/envelope/syntax/program/target/identity）と固定の理由コードを、診断・停止理由・HTMLレポートに記録する。要求の形は、空でないフィールド名・選択肢の種類・プログラム名・トークン数・cwdの一致・環境IDを記録する。コマンド本文は合成課題の診断時だけ、秘密値を伏せて保存する。
- 永続化の提案は、あるだけでは拒否しない。応答は今回だけの `accept` か `decline` だけで、選択肢に `accept` がなければ拒否する。
- `"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command '<中身>'` の完全一致形（パス区切りは単一または二重）だけを外し、中身に従来の判定を適用する。pwsh・他のオプション・追加引数・中身の引用符/`$`/バッククォート/改行は拒否する。承認は、ラッパーを含む元のコマンド全文・作業場所・対象に結び付ける。
- ラッパー経由の登録テストは自動許可せず、今回だけの確認へ回す（直接の完全一致は従来どおり）。
- `environmentId` は、thread/startの応答で環境が選ばれていない（空かnull）場合に、短い英数字のIDだけ通す。XHarnessは `environment/add` を呼ばない。
- これまで理由なしで終わっていた停止経路に固定コードを付けた。対象は、turn不一致・入れ子agent・モデル変更・未対応のサーバー要求（メソッド名を記録）・Codexのturn失敗（`codexErrorInfo` の種別名だけを記録し、本文は保存しない）。完了したコマンドの終了コードも記録する（出力本文は保存しない）。
- 公式workflowのClaude候補は、SDKが解決した完全モデルIDだけを使う（`pinClaudeModels`）。完全IDを確認できない別名は使わない。
- [SPEC §15](../SPEC.md) を上記に合わせて更新した。

## 模擬テスト

関連範囲だけを実行した（全回帰・全GUIは実行していない）。`src/main/workflow/official/` 全体と `OfficialWorkflowPanel.test.tsx` の15ファイル・178件が成功。型チェック・ESLint・Prettierも成功。確認した内容は次のとおり。

- 拒否の段階と理由
- ラッパーの完全一致と近い形（13種）の拒否、中身への従来の判定の適用
- ラッパー経由テストの個別確認
- `accept` が選択肢にない場合の拒否
- 環境IDの条件
- 応答が `accept` だけで、amendmentを返さないこと
- 未対応要求・turn失敗・モデル変更の停止コード
- 終了コードの記録（出力本文は記録しない）
- 秘密値を保存しないこと

既存の承認・拒否・内容変更・重複要求・取消・期限切れ・再起動の試験も、修正後に成功した。

`service.test.ts` と `runtime.test.ts` の5件は、この環境では既定の5秒で時間切れになる（各5〜6.5秒）。修正前のHEADでも同じく失敗し、上限30秒では成功するため、今回の変更による回帰ではない。製品のタイムアウトは変更していない。

## 実通信（開発ビルド、配布版ではない）

開発ビルド（`out/`、`electron-vite build`）を、隔離した `XHARNESS_HOME`、`--official-only`、PATH先頭をユーザーのStore版pwshにして起動した。補助スクリプト `.out/approval-live.mjs` は承認しない。計画承認と操作承認は、利用者が実際の画面で押した。Codexは `codex-cli 0.160.1`（`…/Codex/bin/5ea220ae823df3d7/codex.exe`）、Node 24.16.0。ソースは `3dd8cb0` に未コミット変更を加えたもの。

| 試行 | 修正の段階           | 結果                                                                                                                                                                                                         |
| ---- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | 理由の記録のみ       | `envelope: execpolicy-amendment` で拒否。上記のコマンドを確認                                                                                                                                                |
| 2    | A・B実装後           | Codex実装が約5秒で失敗。承認要求・項目なし。当時は理由を記録する経路がなく、原因不明                                                                                                                         |
| 3    | 停止理由の記録を追加 | ラッパーと提案は通過。`envelope: environment` で拒否                                                                                                                                                         |
| 4    | 環境案A実装後        | **個別承認UIに到達。利用者が「今回の操作だけ許可」を押し、`allowed`/`explicit` を記録**。ただし許可したコマンドの実行がCodex側で `failed`。続く `rg --files -g add.mjs` は許可対象外として正しく拒否し、停止 |

試行4の操作承認は、request `19f0d22e…`、session `01a111a5-ce96…`、turn `01a111a5-cee1…`、item `exec-10f1ef67…` と元のコマンド全文に結び付いていた。`add.mjs` は変更されず、HEAD=base。独立テストとClaudeレビューには到達していない。

### 通信回数とトークン

| 対象                                  | 回数 | In                  | Out              |
| ------------------------------------- | ---- | ------------------- | ---------------- |
| Claude（計画、`claude-opus-5-5`指定） | 4    | 72,920              | 3,742            |
| Codex（実装、`gpt-6-luna`/low）       | 4    | 22,112（試行4のみ） | 153（試行4のみ） |

- Claudeの4回はすべて、指定・解決済みID・SDK初期化・主系列assistant（parent=null）が `claude-opus-5-5` で一致した。各回のmodelUsageにHaikuも含まれる（各回In1,564/Out10〜14）。Haikuの役割は記録から判定できず、推測していない。
- ClaudeのInは、input・cache read・cache creationの合計（cacheはIn内数）。Opusの例は、試行1でin4/cache read12,847/creation3,819。
- Codexの試行1〜3は `usage=null` で**欠測**（0ではない）。試行4はthread累計で、cachedInputTokens 9,984（In内数）、reasoning 0。SDK・App Server内部のHTTP往復数は欠測。
- 予算（各5回）のうちClaude 4・Codex 4を使用した。残りは各1回のため、計画・実装・レビューを1回で完了できない。そのため追加の試行は行っていない。

## 未解決・未検証

- 試行4で、利用者が許可した `Get-Content -LiteralPath add.mjs` がCodex側で失敗した理由は不明。終了コードは次の通信から記録される（出力本文は保存しない）。Windows PowerShell 5.1のsandbox内実行の問題か、パスの問題かは未確認。
- Codexは失敗後、`rg` でファイルを探そうとした。SPEC §15の許可対象はGet-Contentだけなので拒否は正しいが、Codexの実装を完了させるには、読み取りの失敗原因の解消か、許可対象の見直し（要人間承認）が必要。
- 試行2の早期失敗は再現せず、原因不明。
- 独立テスト→Claudeレビューの実通信は未実施。
- 配布版（exe）での確認は未実施。今回の実通信は開発ビルドで、配布版とはElectron・同梱パスの条件が異なる。
- 以前のHaikuがSonnetの主応答になった原因は未確定。今回は完全IDの指定で、Opusの4回とも一致した。
