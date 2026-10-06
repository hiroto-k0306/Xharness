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

## 追加調査：承認済みGet-Contentの実行失敗（試行5）

許可対象は広げず、合成課題の実行itemごとに次を記録するようにした（`diagnostics.commandRuns`、HTMLレポートにも表示）。

- itemId・状態・終了コード・所要時間・source・cwdの一致
- 合成課題の診断時だけ、秘密値を伏せたコマンド文字列・cwd・出力末尾4000文字

出力は、itemの `aggregatedOutput` がなければ、同じitemの `outputDelta` を使う。App Serverのitemに実行引数配列はないため、`argv: "not-provided"` と記録し、推測しない。Codexが報告しない値はnullのままにする。

試行5（ソース `c97249d`＋この記録の未コミット変更、開発ビルド）。Claude計画1回（`claude-opus-5-5`で一致）とCodex実装1回で予算を使い切る。実装後は補助スクリプトが停止し、テスト・レビューには進まない設定にした。

1. 利用者が計画を承認した。Codexが `"…powershell.exe" -Command 'Get-Content -Raw add.mjs'` を要求し、利用者が「今回の操作だけ許可」を押した（`allowed`/`explicit`、environment `local`、thread環境0件）。
2. 実行結果は item `exec-d8e614fe-998a-48d6-b8e9-995c1e70c638`、`failed`、**終了コード1**、269ms、source `unifiedExecStartup`、itemのcwdはworkflowと一致（`…\xh-approval-trial-5-P04ac7\official-workflows\456a8581-…\workspace-6BlG6t`）。
3. 出力（秘密値を伏せた記録、`aggregatedOutput`）のASCII部分は次のとおり。
   ```
   Get-Content : … 'C:\add.mjs' …
   + CategoryInfo : ObjectNotFound: (C:\add.mjs:String) [Get-Content], ItemNotFoundException
   + FullyQualifiedErrorId : PathNotFound,Microsoft.PowerShell.Commands.GetContentCommand
   ```
   非ASCII部分は、Codexから届いた時点でU+FFFDに置換されており復元できない。バイト列はCP932の「パス」をUTF-8として解釈した形に一致するが、推測で復元していない。
4. Codexが同じコマンドを新しいitem（`exec-099fd8f6…`）で再要求した。利用者の拒否（または期限切れ）でphaseを停止し、自動再試行はしていない。`add.mjs` は未変更、HEAD=base。

### 判明したこと

- 失敗の直接原因：**Windows PowerShellが相対パス `add.mjs` を `C:\` 基準で解決した**（`C:\add.mjs` が存在しない）。Codexが報告したitemのcwdはworkspaceと一致しているため、報告されたcwdと実プロセスの作業ディレクトリが一致していない。
- XHarnessの承認判定・応答は意図どおり動いた。許可は今回の1件だけで、再要求には新たな確認が出た。

### 未確認（推測しない）

- 実プロセスの作業ディレクトリが `C:\` になった理由。Codexのsandbox実行（`unifiedExecStartup`）が、ユーザーTemp配下のworkspaceを作業ディレクトリにできなかった可能性はあるが、ACLや実行ユーザーの記録はなく、確認していない。
- 実行引数配列（App Serverが提供しない）。

### 通信の合計（試行1〜5）

| 対象                              | 回数       | In                     | Out                 |
| --------------------------------- | ---------- | ---------------------- | ------------------- |
| Claude（計画、`claude-opus-5-5`） | 5（予算5） | 91,173                 | 4,738               |
| Codex（実装、`gpt-6-luna`/low）   | 5（予算5） | 33,866（試行4・5のみ） | 222（試行4・5のみ） |

- 試行5の内訳：Claude In18,253/Out996、Codex In11,754（cached 0）/Out69。
- Codexの試行1〜3は `usage=null` で欠測（0ではない）。
- 予算を使い切ったため、追加の実通信は行わない。

### 次に必要な判断

workspaceの場所（現在はXHARNESS_HOME配下）で、Codexのsandbox実行が作業ディレクトリを使えるかの確認が必要。許可対象・sandbox設定は変更していない。調査には、Codex側の実行条件の確認、または新たな通信予算の承認が必要。

## 原因の確定：elevated sandboxでのPowerShellの現在位置（2026-10-07）

追加予算（Codex最大2回・Claude0回）の承認を受けたが、モデル通信は使っていない。既存のログと、ローカルの `codex sandbox` だけで原因を確定した。

### 既存ログ

`~/.codex/.sandbox/sandbox.2026-10-06.log` を読み取った。Codexの設定は `[windows] sandbox = "elevated"`。

承認したコマンドが実行された2回の直後に、`codex-command-runner-0.160.1.exe` が同じエラーを出していた（試行4の23:37:58.806、試行5の23:50:47.807）。

```
junction: failed to create C:\Users\Default\.codex\.sandbox\cwd: アクセスが拒否されました。 (os error 5)
```

直前の `codex-windows-sandbox-setup.exe` は、workspaceへの書込ACE付与と `.git` のdeny ACEを `errors=[]` で完了している。

### 切り分け（`codex sandbox`、モデル通信なし、ユーザー承認済み）

`codex.exe sandbox -c sandbox_mode="workspace-write" -c windows.sandbox="elevated" -- powershell.exe -NoProfile -Command …` を、使い捨てフォルダ2か所で各1回実行した。

| cwd                                 | 終了 | PowerShellの現在位置 | OSの作業ディレクトリ | `add.mjs`    |
| ----------------------------------- | ---- | -------------------- | -------------------- | ------------ |
| `%TEMP%\xh-sandbox-probe-q467p5`    | 0    | **`C:\`**            | probeフォルダ        | **読めない** |
| `D:\AIwork\xh-sandbox-probe-q467p5` | 0    | probeフォルダ        | probeフォルダ        | 読める       |

Temp側だけ、同じjunctionエラーが記録された（00:02:50.839）。D:側には記録されていない。サンドボックスの `USERPROFILE` は両方とも `C:\Users\ahwri`。

Codexのsetupは各probeフォルダにsandbox groupの書込ACEを付与した。probeフォルダは作業後に削除した。`AppData` への読取ACEは、試行時にCodexが付与済みのものがそのまま残っている。

### 結論

- 原因：Codexのelevated sandbox（codex-command-runner 0.160.1）で、cwdがユーザーのTemp配下のとき、作業ディレクトリ用のjunctionを `C:\Users\Default\.codex\.sandbox\cwd` に作れない（アクセス拒否）。このとき**OSの作業ディレクトリは正しいが、Windows PowerShellの現在位置が `C:\` になる**。そのため相対パス `add.mjs` が `C:\add.mjs` として解決され、`PathNotFound`（終了コード1）になった。
- 同じcwdでもユーザープロファイル外（D:）ではjunctionエラーがなく、正常に動いた。
- XHarnessの承認判定・cwdの受け渡し・応答は原因ではない。

### 未確認（推測しない）

- junctionを使う条件と、失敗時に `C:\` になる仕様上の理由（Codex側の実装は未確認）。
- Temp以外のユーザープロファイル配下（例：既定の `~\.xharness`）でも同じになるか。今回は試していない。
- 実際のApp Server経由で、プロファイル外のworkspaceなら実装が完了するか。モデル通信を使っていないため未確認。

### 対策の候補（未実施・要判断）

1. 公式workflowの合成workspaceを、ユーザープロファイル外に作る（設定または検証用の `XHARNESS_HOME` の場所）。
2. Codex側の不具合として報告する（junctionの作成先が `C:\Users\Default` になる点）。
3. 現状の記録・停止のまま運用する（相対パスの読み取りが失敗し、承認済み操作でも完了しない）。
