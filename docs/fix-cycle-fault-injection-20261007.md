# 修正経路の検証用 障害注入（2026-10-07、ユーザー承認の案B）

レビュー指摘後の修正サイクルを実通信で確実に確認するため、検証専用の障害注入を追加した。

この段階では、実装とモック・ローカルテストだけを行った。モデル通信・Codexのsandbox診断・ACL/trustedの変更は行っていない。仕様は [SPEC.md §15](../SPEC.md) に記載した。

## 有効になる条件

次の4つがすべてそろうときだけ有効になる（`verificationMode`）。

- `--official-only`
- `--verify-fix-cycle`
- `XHARNESS_FAULT_INJECTION=fix-cycle-v1`
- 既定（`~/.xharness`）以外の、絶対パスの `XHARNESS_HOME`

それ以外では、パネルに作成ボタンが出ない。サービスも `task: "typed-add-v1"` を拒否し、runtimeに注入の設定が渡らない。

## 課題（typed-add-v1）

- ゴール：仕様をそのまま伝える。隠した要件はない。

  > a・bがともに有限のnumberなら和を返す。それ以外（左右どちらでも、NaN・±Infinity・undefined・数値文字列）はTypeErrorを投げる。テストは変更しない。

- 初期状態：`export const add = (a, b) => a - b;`
- 登録テスト：`typed-add`（`node --test acceptance.test.mjs`）
  - 正常例：`add(2,3)=5`、`add(-1,1)=0`、`add(0.5,0.25)=0.75`、`add(1.5,-0.5)=1`
  - TypeError：上記の10通り（左右それぞれ）

## 流れと記録

| 段階 | 対象                                                                                                    | テスト                                    | レビュー         | 何の確認か |
| ---- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------- | ---------- |
| X1   | 実装のコミット                                                                                          | 実施（`injection.stages[quality].check`） | **対象外**       | 実装品質   |
| X2   | 注入コミット（作者 `XHarness fault-injection`、メッセージ `fault-injection: fix-cycle-v1 <effect id>`） | 実施（終了コード1の失敗を想定）           | 実施（base..X2） | 修正経路   |
| X3   | fixのコミット                                                                                           | 実施                                      | 実施（base..X3） | 修正経路   |

- 注入内容は固定で、注入であることをコメントに明記する（`INJECTED_SOURCE`）。
- `record.injection` に記録するもの：
  - `state`・`attempts`・`stages`
  - 各段階の `head`、`checks` / `reviews` の添字
  - 注入時刻・内容digest・許可フォルダ
- baseは最後まで変わらない。
- レポートには「修正経路の検証（障害注入）」の表と、通信上限・予約数を表示する。

## 安全側の扱い

### 注入の条件

注入は、次がすべてそろうときだけ行う。

- 試行が0回で、コミットがX1の1件だけ、HEADがX1。
- workspaceのトップと `--absolute-git-dir` の実体パスが、課題用フォルダの中にある。
- baseの `add.mjs`・`acceptance.test.mjs` が、専用課題の内容と一致する。

これらを満たさない場合は、書き込む前に `fault-injection-outside-boundary` / `fault-injection-not-synthetic-task` / `fault-injection-not-allowed` で止まる。

### 中断と再開

- 書き込む前に、`pendingEffect: inject`・`state: injecting`・`attempts+1` を保存する。
- 次の状態の記録は、再開しない（`uncertain-injection`）。
  - injecting（`pendingEffect` を消しても同じ）
  - failed
  - ineffective
- 注入した後から再開しても、二重には注入しない。
- 注入の設定・通信上限を変えて再開すると、`execution-scope-changed` で止まる。

### 古い結果を流用しない

既存の検知は維持している。

- レビュー前の `stable()`
- 最新のテスト結果のheadと現在のheadの一致（`invalid-checkpoint`）
- `review-snapshot-mismatch`
- 範囲・秘密情報を検査する既存のcommit処理（注入のコミットも通す）

### テスト結果の分類

| 結果                                    | 扱い                                               |
| --------------------------------------- | -------------------------------------------------- |
| 終了コードのある失敗                    | 想定内。修正経路へ進める                           |
| 終了コードなし                          | 停止（`verification-infrastructure`）              |
| 負の終了コード                          | 停止（同上）                                       |
| 監督プロセスの起動・封じ込め失敗（125） | 停止（同上）                                       |
| X2が合格                                | `fault-injection-ineffective` で、レビュー前に停止 |

レビュー指摘0件でも、テストが失敗していれば修正に進む。レビューの見落としとは断定しない（レポートに明記）。

### 通信上限

- phaseごとの上限は、計画1・実装1・修正1・レビュー2。
- runningの記録と同時に、`callBudget.reserved` を送信前に保存する。
- 上限を超える呼出は、送信前に `call-budget-exceeded` で止める。
- 再起動後も、予約数を引き継ぐ。

## 検証（変更範囲のみ）

`fault-injection.test.ts` に14件を追加した。

- 有効化の条件（7通り）。
- 課題：初期・注入・不完全実装が不合格で、仕様どおりなら合格。テストに全ケースがあること。
- X1/X2/X3の分離：コミット・テスト・レビューのhead、fixへの受け渡し、予約数、git log、レポート。
- 指摘0件でもテスト失敗を合格にしないこと。
- X1が不合格なら注入せず、自然な修正経路をたどること。
- 境界外・専用課題以外へは注入しないこと（以降の通信なし、再開不可）。
- 注入の効果がなければ、レビュー前に止まること。
- テスト基盤の異常で止まること。
- 注入中の中断を再開しないこと（`pendingEffect` を消しても同じ）。
- 注入後の再開で、二重に注入しないこと。予約を引き継ぐこと。設定を変えた再開を拒否すること。
- 上限超過の呼出を、送信前に拒否すること。
- 通常の実行には `injection` / `callBudget` が付かないこと。
- 検証モード以外では、サービスが検証課題を拒否すること。

`OfficialWorkflowPanel.test.tsx` に2件を追加した（ボタンは検証モードでだけ出ること、送るコマンド）。

結果：

- official workflow配下とパネルのテストは、19ファイル・259件が成功した。IPC・プロファイルのテストも成功した。
- 型チェック・ESLint・Prettierも成功した。
- 全回帰は実施していない。

## 未確認

- 実通信での修正サイクルの通しは、未実施。
- 配布物へは、まだ反映していない。
- 実通信の手順・通信回数（Codex 3・Claude 2）と停止条件は、[sandbox-node-fixcycle-haiku-20261007.md](sandbox-node-fixcycle-haiku-20261007.md) の4節による。

## Codex引き継ぎ後の限定修正（2026-10-07）

対象は `86df113`（コード `830971a`）からの本コミット、ブランチ `feature/official-workflow-single-task`。上記の実装・試験記録は当時の結果として残す。ユーザー承認済みの修正2点だけを扱い、モデル通信・Codex sandbox診断・ACL/trusted変更・配布物作成は行わない。

### 固定fixtureの失敗判定

`typed-add` だけに `--test-reporter=tap` を指定する。既知の2テストの名前・番号・集計、キャンセル/skip/todoなし、exitとpassedの一致を確認する。不合格はすべて `testCodeFailure` / `ERR_ASSERTION` のときだけ想定内とする。Node起動後のfixture読込エラーや、未知・不完全な結果はexit 1でも `verification-infrastructure` で停止し、レビュー・fixを送信しない。通常のテスト実行や一般のtest frameworkは変更しない。

### 注入内容と承認の結合

注入内容・fixture初期ソース・fixtureテストのSHA256を実行範囲に含める。障害注入の計画承認は計画と実行範囲digestの組合せに対して行い、予算・テスト・注入定義の変更で過去承認を流用しない。保存された定義は再開時、注入境界確認時、pending保存後の書込み直前に現在の定義と照合する。

通常記録は従来の実行/計画承認digestを維持する。以前の障害注入記録は定義情報が足りないため、安全側に再開拒否する。新しい通信予約の保存に失敗した場合はagentを呼ばない。

### オフライン検証

Windows / PowerShell 7.6.5（Codex同梱の `C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。テスト・型チェックは `scripts/pnpm.ps1` とローカルNode 22.23.3（`.tools/node_modules/.bin/node.exe`）を使用。lint/formatは同梱CLIを直接実行し、Node 24.16.0（`C:/Program Files/nodejs/node.exe`）を使用。Store版pwshや配布Electronの確認結果ではない。

- 重点：`fault-injection.test.ts` 20件成功。ログ `.out/codex-fixcycle-focused.log`。
- 関連回帰：`fault-injection`・`runtime`・`catalog-compat`・`service`・`report` の5ファイル90件成功（重点20件を含み、件数は合算しない）。ログ `.out/codex-fixcycle-regression.log`。
- 最終typecheck成功：`.out/codex-fixcycle-typecheck-final.log`。途中の定義共通化でliteral型がstringへ拡大したエラーは戻り値型を指定して解消し、失敗ログ `.out/codex-fixcycle-typecheck.log` も保持した。
- 変更した3つのTypeScriptファイルのESLint成功：`.out/codex-fixcycle-lint.log`。
- 変更したコード・SPEC・本報告書のPrettier check成功：`.out/codex-fixcycle-format-check.log`。`pnpm exec prettier` のshimが見つからなかったため、`node node_modules/prettier/bin/prettier.cjs` を直接実行した。
- 追加した根拠：Nodeによる実際のfixture読込失敗（exit 1）でレビュー/fix未送信、未知exit 1拒否、同一specの注入/fixture digest変更で再開と注入条件確認を拒否、通信予約保存失敗で未送信。
- 既存のX1品質不合格からの自然な修正、X1/X2/X3とテスト/レビューのHEAD対応、注入後再開、予算引継ぎ、通常記録・旧モデル記録も関連範囲で確認する。

全回帰・GUI・build/package・実通信・sandbox診断は未実施。配布物は旧版のままであり、修正サイクルの実測はまだ未確認。

## 限定オフライン配布確認（2026-10-07、ソース54a6e92）

上節の修正をコミットした `54a6e92ca223a312ae40bae824cac06c4a19a803` のclean状態から `scripts/pnpm.ps1 package:dir` を実行した。ソースは変更していない。旧 `dist/` は `.out/pre-54a6e92-dist/` に退避し、旧exe `341fc729…99a1` / asar `2b36da22…4fb0` のhashも保持した。インストーラーやportableの作成、上書きインストールは行っていない。

最初の隔離実行ではtsxの `uv_os_get_passwd` がENOMEMとなり、icon処理で失敗した。ACL等を変更せず、同じ配布コマンドを通常権限で再試行して成功した。失敗ログ `.out/codex-fixcycle-package-dir.log` と成功ログ `.out/codex-fixcycle-package-dir-retry.log` を保持する。環境は前節と同じPowerShell、ローカルNode 22.23.3。builderはElectron 44.5.1 / win32 x64を使用した。

| 配布物                                 | SHA256                                                             |
| -------------------------------------- | ------------------------------------------------------------------ |
| `dist/win-unpacked/XHarness.exe`       | `8cd0029f1d470025153921b3f080c573d38aeb1e59fc73c84f137fc82b8f7850` |
| `dist/win-unpacked/resources/app.asar` | `46c525d81908285f51aff1f6bebb47a625129d101e1066fc0d7da4df3cdef512` |

ソース・新旧hash記録：`.out/codex-fixcycle-package-source.json`。

### 配布物のUI（モデル通信なし）

Playwrightから今回のexeだけを起動した。5回とも固有のTemp homeと `electron-user-data` を確認し、`app.isPackaged=true`。安全な起動確認として全ケースに `--fake` を付けた。既存アプリや通常のuserDataは使用・停止していない。

| 条件                                           | 結果                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| 通常起動相当（`--fake`のみ、注入環境値はあり） | 検証modeなし・注入ボタンなし                     |
| `--official-only`なし                          | 同上                                             |
| `--verify-fix-cycle`なし                       | 同上                                             |
| 環境値が `fix-cycle-v1` 以外                   | 同上                                             |
| 4条件成立（加えて`--fake`）                    | `fix-cycle-v1`、検証説明と有効な作成ボタンを表示 |

作成・質問・接続設定ボタンは押さず、実サービスの記録は0件のまま。最後にこの確認で作った5プロファイルだけを削除した。既定・欠測・相対HOMEでは安全な隔離起動ができないため、実アプリを起動せず共通resolverだけを直接確認し、いずれもmodeなしだった（配布UIの実起動確認とは区別する）。

### 承認画面（同一の配布renderer、IPC mock）

計画生成を呼ばず、最後の隔離アプリ内だけでworkflow IPCをmockへ差し替えて承認状態を表示した。mockはlistと承認記録以外を拒否し、実サービスの承認・dispatchは行っていない。

- 注入・fixture定義、テスト、budgetを含む実行digestと計画から承認digestを計算し、画面の表示値とmockへ送られた値が一致した。
- 注入内容digestを変えて実行digestを再計算すると承認digestも変わり、画面も新しい値を表示した。
- 注入content SHA256自体はこの承認UIに表示されない。記録・HTMLレポートに保存される項目であり、今回確認したのは結合済みの承認digestの表示・送信。実計画を生成した承認画面の確認ではない。

証跡：`.out/codex-fixcycle-packaged-ui.json` / `.log`、`codex-fixcycle-pkg-normal.png`、`codex-fixcycle-pkg-mode.png`、`codex-fixcycle-pkg-approval-mock.png`（いずれも `.out/`）。

### 未確認と次の実通信条件

- 実通常homeでの非fake起動、実SDK/App Serverで生成した計画と承認画面、X1/X2/X3の実モデル通しは未実施。今回のmock画面を実モデル成功と扱わない。
- 次は新たな明示承認が必要。通信上限はCodex計画1・実装1・fix1、Claudeレビュー2（最大5phase、SDK内部往復数は別）。この配布物のhashを固定し、4条件の隔離homeと既存の実体workspace保存先、公式Codexパスを使う。trusted/ACL付与の可能性も実通信前に対象を提示する。
- モデル・effort・通常枠の公式確認、利用者による計画/操作の個別承認、保存された内容digest/実行scopeと通信予約を維持する。異常・不明・予算超過は停止し、追加試行を自動で行わない。X1不合格で注入をskipした場合を障害注入の成功と読み替えない。

新しいモデル通信・Codex sandbox診断・ACL/trusted操作は0回。全GUI・全回帰は行っていない。この配布確認のdocs変更は未コミット（前回の作者承認は前回1コミットだけ）。


## PC代理操作による限定実通信試行（2026-10-07、ソース54a6e92）

ユーザーの「PC操作も許可します。操作できないなら他先に進めて」により、許可済みの単一試行を実画面から進めた。承認者は人間のクリックと偽らず `assistant-on-behalf` と記録する方針とした。製品コードや既存設定を広げず、上節と同じexe/asarを使用。既存の本書の未コミット追記も保持した。

- 新規HOME：`C:/Users/ahwri/AppData/Local/Temp/xh-fixcycle-live-54a6e92-20261007-a`。
- 新規workspace保存先：`D:/AIwork/xh-fixcycle-live-54a6e92-20261007-a`。
- 許可予算：計画Luna low 1、実装/fix Sol medium各1、レビューSonnet medium 2。phase 120秒・個別操作承認10分・全体20分。計画や観測が異なれば停止する。
- 代理操作手段：既存Playwrightから今回だけの配布Electronと新規Edgeウィンドウを起動した。専用Computer Useツールは利用できず、追加インストールはしていない。ブラウザは製品HTMLレポートの確認用で、既存ブラウザのprofileは使用しない。
- 4条件の検証mode、非fake、分離されたuserData、Luna low、Codex実装候補、専用workspace保存先を実画面と製品のlist応答で確認した。設定保存は新規HOMEの中だけ。

### 結果：準備段階で停止、修正経路は未確認

検証課題作成は1回だけ実行した。製品画面は「workflowを開始できませんでした。再送していません。」を表示し、保存recordは0件だった。課題IDは `a5ec2134-a761-4f10-a881-87487ffee461`。その専用workspaceには初期の `add.mjs` と `acceptance.test.mjs` があり、`.git` はなかった。`workspace.json` はあるが `workflow.json` / `report.html` は生成されていない。

現行コードの順序（fixtures.tsのファイル作成→git init、service.tsのworkspace作成→初期record保存→接続/実行）と残った内容から、Git初期化を含むfixture準備中に停止しており、公式モデル接続・plan/implement/review/fixの送信には到達していない。具体的なプロセスエラーは画面に出ず、根本原因は未確定。欠測usageをゼロ扱いした結論ではなく、dispatch前の停止として区別する。

- 実画面から計画作成ボタンを1回操作。計画承認・個別操作承認は0回。
- モデルphase・受入テスト・障害注入・X1/X2/X3はいずれも未実施。
- HTMLレポートは未生成で、実計画のレビュー担当やcontent digestの画面確認も未実施。
- 不明結果で停止し、新しい試行・モデル切替・製品修正は行っていない。今回の失敗をモデル品質やサブスク消費の測定値と扱わない。

作成操作は最初、自動承認レビューに「外部プロバイダへの送信許可が確認できない」と拒否された。既存の通信許可・追加のPC操作許可と、送信対象が新規の固定synthetic課題だけであるコード根拠を示し、同一操作を一度だけ再審査して許可された。別手段で拒否を迂回していない。その後の停止は上記の製品準備失敗であり、自動承認レビューの継続中の拒否ではない。

### 後片付けと証跡

起動した専用Electron/Edgeだけをcloseした後、fixtureとsidecar、画面、list応答、ACL/configの前後metadataを `.out/fixcycle-live-54a6e92-20261007-a/` に保存した。新規HOME/rootは、絶対実体パスとreparse pointなしを確認してから、許可された2フォルダだけ削除した。

- Codex configの前後SHA256：`2c4a20ff9a4431c7cd1502c91ac660825f5e3211c8e070d5f985b85cfd7ccecc` で一致。新規trusted項目なし、従来6項目を保持。
- `D:/AIwork`・`C:/Users/ahwri/AppData`・`C:/Users/ahwri/.claude.json` のACL metadataは前後一致。資格情報の内容は読んでいない。
- 証跡：`trial.json`、`ui-1.png`（送信前）・`ui-2.png` / `ui-3.png`（停止後）、`view-*.json`、`pre-cleanup.json`、`cleanup.json`、`acl-before.json` / `acl-after.json`、`config-before.json`、初期fixtureのコピーとworkspace sidecar。
- 操作用補助スクリプトはignoredの `.out/fixcycle-live-driver.mjs`。製品へのmock注入はせず、モデル操作は製品UIを通した。

今回の変更はこの結果追記のみ、未コミット。前節までの関連90件・typecheck・lint・package成功は以前の検証結果であり、今回はそれらを再実行していない。残課題は配布版のfixture準備失敗の原因特定と、実モデルでの修正経路の通し確認。再試行は新たな指示があるまで行わない。


## 準備失敗のオフライン診断と限定修正（2026-10-07、HEAD 54a6e92）

ユーザーの追加指示により、モデル通信・Codex sandbox起動・ACL/trusted変更・live再試行を行わず診断した。既存の未コミット追記を保ち、新規コミットはしていない。

### 取得できたエラーと限界

- 元trialの具体的なexit/stdout/stderrは残っていない。fixtures.tsの `execFile("git", ...)` の失敗はservice.tsのcatchで一般メッセージに置き換えられる。元trialは初期ファイル2件があり `.git` がないため、最初の `git init -q` を含む準備中の失敗まで特定できるが、根本原因は断定できない。
- 補助スクリプトと同じPATHの作り方、同じGit引数・cwd指定で、workspace内の新規ローカルfixtureを準備した。init/add/commitはすべてerrorなし、exit 0。init/commitのstdout/stderrは空、addのstderrはLF→CRLF警告だけ。固定XHarness identityをコマンド単位で指定したcommitも成功した。これらの設定を原因だと推測して変更しない。
- 次に今回の配布Electronだけを `--fake --official-only` と新規Temp HOMEで起動し、モデルなしのGit準備だけを診断しようとした。Electron child（ログPID 47760）が `electron/shell/browser/win/install_dir_access.cc:52` でFATALになった。メッセージは、配布物のディレクトリACLにAppContainer package SIDがありALL APPLICATION PACKAGESのACEがないためsandbox tokenによる読み取りを拒否、というもの。Playwrightは20秒timeoutになり、Git診断自体に到達しなかった。
- これは今回の通常隔離診断の具体的な権限エラーであり、正常にUIが開いていた元の通常ユーザー権限trialと同じ原因とは判断しない。ACLを付与せず、権限を変えた再起動もしない。プロセス照会のWin32_Processもaccess deniedだったため、権限を広げた照会やプロセス停止は行っていない。

### 最小修正：Git準備の失敗を確認できるようにする

明確に確認できた不具合は、準備失敗の段階・OSエラーコード・終了値が製品表示で失われること。fixtures.tsだけで、各Git実行の失敗を固定形式のエラーへ変換した。serviceの既存「合成課題」メッセージ表示経路をそのまま使い、例えば `合成課題のGit準備に失敗しました（init: code ENOENT, exit 不明）。再送していません。` を表示する。

公開するのは固定step（init/add/commit）、限定OSコード（ENOENT/EACCES/EPERM/ETIMEDOUT/ENOSPC/EBUSY/EIO、その他はunknown）、整数の終了コードだけ。生のエラー本文・stdout/stderr・環境設定は出さない。Git identity・cwd・PATH・コマンド引数・権限・再試行動作・保存形式は変更しない。この修正を元trialの根本原因解消と扱わない。

### 関連検証

前節と同じWindows/PowerShell 7.6.5、ローカルNode 22.23.3で関連Vitestとtypecheck。Node 24.16.0でローカルGit再現とlint/format。

- fixtures新規7件（init/add/commit失敗、拒否コード、数値exit、秘密を含む未知code、既存引数/identity維持、製品view表示と接続前停止）＋既存service35件＝2ファイル42件成功。
- `.out/codex-preparation-regression-final.log`。初回41件のログも保持。
- typecheck成功：`.out/codex-preparation-typecheck-final.log`。初回はテスト配列のundefined型2件で失敗し、長さを検証した添字にnon-nullを付けて修正した。失敗ログも保持。
- 変更したTS2ファイルのESLint成功：`.out/codex-preparation-lint.log`。Prettier check成功：`.out/codex-preparation-format.log`。
- build/package、実UIでの新エラー表示、全回帰、実通信は未実施。配布物は引き続き54a6e92のまま。

### 証跡と後片付け

`.out/fixcycle-live-54a6e92-20261007-a/offline-preparation.json` にローカルGit準備結果、`offline-electron-preparation.json` に具体的なElectron起動エラーを保存した。ローカルGitfixtureとVitestのfixtureは削除済み。

Electron診断のTemp `C:/Users/ahwri/AppData/Local/Temp/xh-preparation-offline-erLCpj` は削除時に `home/electron-user-data/lockfile` がEBUSYとなり、再確認でも使用中だったため、完全削除できていない。今回の親PID 40320は後のGet-Processに存在しなかったが、lockfile保持者は未特定。既存プロセスや不確かなPIDを終了せず、残った専用一時領域を `offline-electron-cleanup.json` に記録した。ロックが解放されてからこの領域だけの削除が必要。

残課題：元の配布trialにおけるGit init失敗の具体的な原因、実モデル修正サイクル、新診断表示の配布確認、診断Tempの残存lockfile。新しいlive・ACL修正・追加設定変更は実施しない。新規コミットは今回分の作者承認待ち。

最終境界確認：offline-boundaries.jsonで既存ACL・Codex configの前後一致を確認。最終ESLintも成功（.out/codex-preparation-lint-final.log）。


## 限定後片付けとコミット承認（2026-10-07）

ユーザーは今回の診断プロセスだけの通常終了・専用Temp片付けと、今回の診断修正/報告を `Codex <codex@local>` author/committerでローカルコミットすることを承認した（Sentinel_b7110b85101881919f7291c90652ecc2）。

PID 47760を再照合し、exe `dist/win-unpacked/XHarness.exe` と開始時刻 `2026-10-07T04:46:32.3580861Z` が今回の診断記録と一致した。新規のisolated HOMEは診断スクリプトと起動ログの対応から確認した。PIDの数字だけで終了を判断していない。`CloseMainWindow()` はtrueを返したが、10秒待っても終了しなかったため、そこで停止。強制終了、他プロセスへの操作、Temp削除は行っていない。証跡は `.out/fixcycle-live-54a6e92-20261007-a/approved-process-close.json`。残存プロセスとlockfileの片付けは未完了。

製品コードは前節の42件/typecheck/最終lint/format成功後に追加変更なし。既存の報告追記を保ち、この結果のみ追加した。今回もモデル通信・ACL/trusted変更・build/package・push/mergeは行わない。作者指定は今回のGit呼出だけに限定し、永続設定・旧コミット作者は変更しない。

コミット前の再確認：42件ログ終了直後にテストのnon-null型注釈だけ更新されていたため、現行fixtures.test.tsの7件を再実行して成功（.out/codex-preparation-precommit-focused.log）。件数を42件と合算しない。


## 診断表示の配布反映準備（2026-10-07、ソース4644f39）

ユーザー承認の範囲で、cleanな `4644f395dfeb4e710051cbb059e044e53ef63195` から同じ既定の隔離実行環境で `scripts/pnpm.ps1 package:dir` を1回実行した。配布起動・モデル通信・Codex sandbox・ACL/trusted変更は行わない。

既存の54a6e92配布物をworkspace内の `.out/pre-4644f39-dist/` に退避し、exe/asar/ICUのSHA256を記録した。退避後もhash一致を確認した。旧退避物 `.out/pre-54a6e92-dist/` は変更していない。

結果はexit 1。最初の `icon`（`tsx scripts/make-icon.ts`）が `node:os:306` の `os.userInfo()` で失敗した。`uv_os_get_passwd` / `ENOMEM` / errno -4057、Node 22.23.3。スタックはtsx 4.23.15の `temporary-directory-Du7LpLp9.mjs:1:659`。OSエラーの文字列はnot enough memoryだが、実際のメモリ不足やACL拒否のどちらかと断定できる根拠はない。

build/packageへ到達せず、診断表示入りのcompiled artifactは今回生成・静的確認できていない。新しい `dist/` も未生成。権限を変えた再試行・別経路での実行・再起動・ACL修正は行わず停止した。ソースコードも変更していない。

証跡：`.out/codex-preparation-package-dir.log`、`.out/codex-preparation-package-source.json`（ソース・退避hash・実行段階・結果）。本追記は未コミット。今回の権限範囲でのビルド失敗の切り分けと配布反映は残課題で、先のGit準備失敗やElectron起動FATALと同根因だとは扱わない。


### tsx失敗の既存記録・ソース比較（同日、追加ビルドなし）

今回と前回54a6e92の初回失敗は、同じ `scripts/pnpm.ps1 package:dir` / Node 22.23.3 / tsx 4.23.15で、`temporary-directory-Du7LpLp9.mjs:1:659` → `os.userInfo()` → `uv_os_get_passwd` / ENOMEM / errno -4057まで一致した。

tsxの該当モジュールは、`process.geteuid` がないWindowsでは `os.userInfo().username` を取得して `<tmpdir>/tsx-<username>` を決める。これはモジュール評価時の処理で、make-icon.tsのmainに入る前に失敗する。依存をpatchしたりOS identityを偽装したりしていない。

pnpm.ps1は既存のローカルbinをprocess PATHの先頭に足し、同梱pnpmへ引数を渡し、finallyで元のPATHへ戻す。package scriptもicon→build→builderの既存順序。引数・cwd・Node選択の誤りを修正すれば解決する、という根拠は見つからなかった。

過去の成功ログではicon/build/builderが通っているが、当時のtool呼出は初回 `use_default` に対し再試行 `require_escalated`（隔離外の通常ユーザー環境）だった。今回も失敗は `use_default`。この実行context差が既知の違いで、同一ログだけから権限拒否や実メモリ不足を確定しない。今回は実行環境変更が禁止されており、安全な呼出修正の根拠もないため、許可された条件付きの再試行は実施しなかった。追加の代替経路も試さない。

比較記録：`.out/codex-preparation-package-comparison.json`。新しいモデル通信・ACL操作・アプリ起動・依存変更はなし。

利用者が通常のPowerShellで同じフローを再現する場合の手順（この診断では未実行、管理者起動やACL変更は不要）：

1. リポジトリ `C:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness-connections` を作業場所にする。
2. `.\scripts\pnpm.ps1 package:dir *> .out\manual-package-4644f39.log` を実行する（ローカルpnpm/Nodeを使う同一フロー）。
3. 完了後に `$LASTEXITCODE` とそのログを確認する。失敗した場合は起動・install・権限変更を続けず、そのままのログで切り分ける。

旧配布物は引き続き `.out/pre-4644f39-dist/` に保全。新しい配布物は未生成。この追記も未コミット。


### ユーザーによる手動package後の静的確認（2026-10-07）

ユーザーが通常のPowerShellで上記packageフローを実行し「終わったよ」と報告した。assistantによる再試行ではない。`.out/manual-package-4644f39.log` は08:08:49 UTCに更新され、icon生成・electron-viteのmain/preload/renderer build・Electron 44.5.1 x64 package・asar integrity更新まで記録されている。明示的な終了コードは保存されていないのでexit 0とは記録しない。`dist/win-unpacked` の新しい生成物を確認した。

- exe SHA256：`0c6a9ee66f9803e5e5bd8e14ca0be67e3372a4db2ea158b533b90345176d7e79`（08:08:49 UTC）。
- asar SHA256：`b2c21ba936fd59dd2f2ba2988267254bc3e41e8bd31ff60796e055dbf6fd1189`（08:08:48 UTC）。
- ICU SHA256：`9f48c7f9c7c94d516a14870707e910ab94d75ae640ff6842c4af53276cd26ebe`（旧配布物と一致）。

HEADは4644f39、tracked code・scripts・package/lock/build設定の差分なし、dirtyは既存の本書追記だけ。asarを起動せずに読み取り、packaged `out/main/index.js` が現在のbuild出力とbytes一致することと、Git準備のstep/code/exit表示を静的確認した。asarライブラリのWindowsパス区切りに合わせて読み取り、製品ファイルを変更していない。

証跡：`.out/manual-package-4644f39-evidence.json`。実アプリ起動・モデル通信・ACL変更・コミットは行っていない。次のoffline準備診断の提案は、ユーザーの通常環境で、新規の絶対HOMEと隔離workspaceを使い、`--fake --official-only` で計画作成まで（承認せず）確認すること。元のGit準備エラーが出れば新しい診断表示で段階/code/exitを確認する。制限環境の起動FATALを迂回する起動や、ACL変更・live通信は提案に含めない。起動診断自体はまだ未実施。

手動専用helperを .out/Start-PreparationProbe-4644f39.ps1 に保存。exe/ログ親存在とHOME/ログ3件の不存在を検査し、固定 --fake --official-only で終了を待ち、XHARNESS_HOMEをfinallyで復元する。構文と固定条件だけ静的照合し、assistantから実行していない。専用HOMEは自動削除しない。本追記も未コミット。

ユーザーの明示live範囲承認（Sentinel_94736de8590c8191b276f3c80827713f）に基づき、手動専用 .out/Start-FixCycleLive-4644f39.ps1 を保存。4644f39配布hashを照合し、既存root/evidenceを拒否。新規c root内home/workspacesのみ作成、固定4条件とLuna lowで起動し、終了後に2つの環境変数をfinally復元する。モデル送信・計画/操作承認・ACL/trusted変更・片付けはhelperが直接行わない。構文/固定条件だけ静的確認し、assistantから実行していない。証跡は.out/fixcycle-manual-4644f39-cに保存する設計。旧fakeのPID24868は今回確認時不在だがresultログ未生成で終了コードは未確認。追記は未コミット。


### ユーザー操作による実修正サイクル成功と限定cleanup（2026-10-07）

4644f39配布物でtask a6aa3e63-2fd8-484c-990d-4c05ae1f38e2がsimulated=false、completedとなった（08:47:24.043〜09:06:05.785 UTC、18分41.742秒）。計画承認待ちを一度中断後、同じ計画を安全に再開。Sonnet lowはユーザーが追加明示承認。実行/承認digestは一致し、phase予約はplan1/implement1/fix1/review2、修正1回、注入1回。

X1 b7daa974a9c9eca37ac3a3d8bd64409eaf667864: 実プロセステスト2/2合格。X2 f9a939ba9e7c9dc0740dd2ce51fbe5efa4f4efd1: 固定故障注入後0/2、ERR_ASSERTIONの実装不具合、Sonnetレビューmust2。X3 2c10d391a9bfcca4e3043025bea5512186446658: 修正後2/2、同一HEADへの最終Sonnet実レビュー指摘0。テストSHA256は承認fixtureと一致。成功判定は製品recordに基づき、sandboxのGit直接監査は所有者差で拒否されたため独立Git確認済みとは扱わない。safe.directory変更や迂回はしていない。

5/5 phaseのusage complete。Codex合計input114451/output833/total115284、cached76288はinput内数。Claude Sonnet合計input4/output846/cache-read4464/cache-write12414、thinking177はoutput内数。SDK補助Haiku合計input4143/output29、cache0。モデル別rawとquery-pipelineを重複加算しない。quota表示のCodex4%、Claude週次41→42%は確定タスク枠消費/API費用とは扱わない。

ユーザーが窓を閉じ、helperは09:11:52.502948 UTC exit0。assistantはXHarnessプロセス不在確認後、承認済み範囲でnewroot D:/AIwork/xh-fixcycle-manual-4644f39-20261007-cのみ削除、そのworkspaceのexact trusted1entryのみ削除。既存6project sectionsは一致、AppData/.claude.json SDDLはcleanup前後一致。ACL変更・force kill・追加モデル通信なし。writerlock解放の削除前独立snapshotはなく、helper終了とプロセス不在を確認した。oldfake HOMEは保持。

削除前にrecord/report/tracesと合成workspace（Git objectsを含む）43ファイルを移動せずコピーし、各SHA256を照合。保全先 .out/fixcycle-manual-4644f39-c/preserved、copy-manifest.json、X1〜X3-test-output.txt、usage-phases.json、ACL metadata、root-inventory.json、trusted-before-cleanup.json。cleanup-result.jsonとcleanup-verification.jsonを保存。Git objectsのコピーは履歴解析/差分独立検証を意味しない。製品証跡の既存trace内input/output以上のX1/X2/X3差分は新規生成していない。本追記は未コミット。
