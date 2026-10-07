# sandbox内のnode・修正サイクルの確認範囲・Haikuの追加使用 2026-10-07

逆方向の実通信検証（3回目）で見つかった3点の調査。実通信は行っていない。保存済みのログとコードだけを使った。

## 1. Codexのsandbox内でnodeが見つからない

### 比較

| 項目             | XHarnessの独立テスト                                                                          | Codexの実装中のテスト                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 起動元           | `runAcceptance`（`workspace.ts`）→ `spawnOwnedProcess`                                        | Codex App Server → `codex-command-runner` → `powershell.exe -NoProfile -Command try { [Console]::OutputEncoding=… } catch {}` + 改行 + コマンド文字列 |
| 起動するもの     | 登録テストの `program`（配布物では `"node"`）と `args`。`shell: false`                        | 文字列 `node --test acceptance.test.mjs` を PowerShell が解釈する                                                                                     |
| 実行ファイル解決 | Node.js（libuv）が、渡したenvのPATHから探す                                                   | PowerShellのコマンド探索（PATH）。結果は「用語 'node' は…認識されません」                                                                             |
| 実行ユーザー     | XHarnessを動かしている利用者（通常のトークン）                                                | elevated sandboxのユーザー（`CodexSandboxUsers`、capability SID付き）                                                                                 |
| PATH             | `runtimeEnvironment()` が引き継ぐXHarnessのPATH。`C:\Program Files\nodejs` を含み、解決に成功 | App Serverには同じ `runtimeEnvironment()` を渡している。sandbox内のシェルに渡ったPATHは**ログに残っていない**                                         |
| cwd              | workspace                                                                                     | workspace（`cwd: same`。同じturnの `Get-Content -Raw add.mjs` は相対パスで成功）                                                                      |
| node.exeのACL    | `BUILTIN\Users:(RX)`・`Authenticated Users:(RX)`                                              | sandboxログで読み取りACLを付けた対象は、AppData・`.claude.json` など特定の場所だけ。`Program Files` は含まない                                        |

### 判定

cwdとコマンド文字列の違いは原因ではない。次の2つの候補を、保存済みのログだけでは区別できない。**原因は未確定**とする。

- (a) Codexがsandbox内のシェルに渡したPATHに、`C:\Program Files\nodejs` が含まれていない。
- (b) sandboxのトークンが `C:\Program Files\nodejs\node.exe` を読めず、コマンド探索が失敗する。

XHarness側の不整合は、登録テストの作り方にある。

- `program: "node"` は、XHarnessのプロセスのPATHで解決する前提になっている。
- Codexに列挙する `command` は、同じテストをsandbox側のPATHで解決する前提になっている。

同じ「登録テスト」でも、実行環境が保証されているのは独立テストだけである。

### 確定させる診断（モデル通信0回、承認が必要）

- 方法：`codex sandbox`（elevated、workspace-write）。
- 対象：使い捨てのフォルダ `D:\AIwork\xh-node-probe-<乱数>`。
- 環境変数：`runtimeEnvironment()` と同じキーだけに絞る。
- 実行するコマンド（1回）：

```
$env:PATH -split ';'; (Get-Command node -ErrorAction SilentlyContinue).Source; Test-Path 'C:\Program Files\nodejs\node.exe'; & 'C:\Program Files\nodejs\node.exe' -v
```

- 副作用：
  - 使い捨てフォルダに書き込みACEが付く。フォルダごと削除する。
  - AppData・`.claude.json` の既存の読み取りACEが再付与される。
- 注意：CLIの `codex sandbox` とApp Serverとで、環境変数の扱いが同じかは確認できていない。

### 最小限の修正案（未実施、要確認）

- **案1（推奨）**：Codexの実装・fixのthreadへの指示から、登録テストを外す。
  - 列挙するのは、計画したファイルごとの `Get-Content -Raw <file>` だけにする。
  - 「テストはXHarnessが独立に実行し、失敗したらfixのphaseで結果を渡す」と伝える。
  - 安全判定は変えない。テストを要求された場合は、従来どおり個別承認に回る。
  - 効果：個別承認が2件から1件になる。sandbox内での失敗も起きない。
  - 承認対象を狭める変更であり、実行ファイルは変更しない。
- 案2：テストの実行ファイルを、作成時に絶対パスへ解決する。
  - 記録・独立テスト・Codexへの列挙のすべてで、その絶対パスを使う。
  - 実行ファイルと承認対象の両方が変わる。空白を含むパスを引用して許可するため、ラッパーの完全一致形を広げる必要がある。
  - 原因が(b)なら効果がない。推奨しない。

## 2. レビュー指摘後の修正サイクル

### 既存のモックテストが確認していたこと

- 指摘と失敗テストのあとに、fixとレビューが回って完了すること（correctionRoundsが1、コミット2件、テスト結果が[失敗, 成功]）。Claude・Codexの両方。
- 各phaseの担当会社の並び。plan → implement → review（別会社）→ fix（実装と同じ会社）→ review。
- 1回目のレビューに、完全なdiffと1回目のheadが渡ること。
- 修正は2回まで。3回目の指摘ではattentionで止まり、モデルの成功主張をテストの根拠にしないこと。
- verify・reviewの途中から再開しても、完了済みのphaseを再実行しないこと。登録テストが変わっていれば `execution-scope-changed` で止まること。

### 未確認だったので追加したこと

`runtime.test.ts` に4件、`codex.test.ts` に1件を追加した。

- fixのリクエストの中身。
  - 直前のレビュー（mustの指摘）・失敗した独立テストの結果・前回のdiffが渡ること。
  - 計画の実装担当のモデルとeffortをそのまま使うこと。
  - 対象ファイルが計画どおりであること。
- 2回目のレビュー。
  - 1回目と同じレビュー担当（モデル・effort）であること。
  - baseは元のまま、headはfix後のコミット。完全なdiffと最新のテスト結果が渡ること。
  - 各テストが、そのときのコミットに対して実行されていること。
- レビューの指摘が0件でも、独立テストが失敗していればfixに進むこと。
- nitだけの指摘でテストが合格なら、fixに進まず完了すること。
- Codexのfixのthreadにも、実装と同じコマンドの列挙が渡ること。

### 残る確認（実通信が必要）

修正サイクルの実通信は、まだ一度も確認していない。

### 実通信での検証手順（案）

1. 合成課題に、ゴールの文に書いていない境界条件を含めた登録テストを用意する。
   - Codexが読めるのは計画したファイルだけで、テストファイルは読めない。そのため、1回目の実装が不合格になる見込みが高い。
   - 確実ではない。1回目で合格した場合は、修正サイクルを通らずに完了する。
2. 計画の承認と個別操作は、既存の承認手順で行う。
3. 1回目の修正のあと、レビューまでで止める。修正上限の2回までは回さない。

通信回数は、Codexの計画1・実装1・fix 1でCodex 3回、Claudeのレビュー2回。1回目で合格した場合は、Codex 2回・Claude 1回で終わる。

## 3. Haikuの追加使用（既存ログのみ）

### ログから分かること

- 指定したモデルがHaiku以外のClaude呼出では、`claude-haiku-4-5-20251001` の使用が**毎回1件**記録されている。
  - 例：承認調査の試行1〜5の計画（Opus）、限定packaged検証、診断、今回のレビュー（Sonnet）。
  - 今回が初めてではない。
- 中身はどれも同じ形をしている。
  - 入力は約0.9k〜1.6kトークンで、プロンプトの大きさに応じて変わる（同じ計画プロンプトでは1,564で一定）。
  - 出力は10〜15トークン。キャッシュは使っていない。
- `usage.iterations` の順序では、主モデルの呼出よりも**前**にある。
- assistantの発言は、すべて指定したモデルのもの。Haikuの発言・tool呼出・モデル切替フックの記録はない。
- 指定したモデルがHaikuの呼出では、Haikuの記録は1件だけで、別の呼出とは区別できない。
- XHarnessはSDKのstderrを捨てており（`stderr: () => {}`）、SDK内部の呼出目的を示すログは残っていない。

### 判定

SDK（Claude Code本体）が、主モデルの前に小型モデルの補助呼出を1回行っているとみられる。ただし、どの機能による呼出かは既存ログからは**確定できない。未解明として残す**。

通信回数・Usageの記録には、この呼出も含まれている（byModelに計上）。
