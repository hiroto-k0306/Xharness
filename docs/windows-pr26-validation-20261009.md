# PR #26のWindows限定検証（2026-10-09）

## 対象・リポジトリ確認

利用者の依頼に従い、D:/AIwork/XharnessでAGENTS.md・SPEC §2/§5/§6/§15/§16・Windows対象手順を確認。開始時HEADは69f155ed724af2c742d7045dc00add8e58ff29e0、main、作業ツリーclean。読取・Git操作は正常で、以前の `setup refresh had errors` は発生しなかった。既存変更のreset/stash/上書きなし。

[PR #26](https://github.com/hiroto-k0306/Xharness/pull/26)は最初の取得時点で既にmerged。HEADは依頼と同じda3e8befe19b31399a67e18f2b009147778db9db、マージコミットは **fce9ebaee0049790737947d735bdaa8da06fb6db**。本セッションで重複マージや保護解除はしていない。base 9a275bcから240ファイルの差分、公式GUI/headless接続、旧HTTP/認証/モデルツール撤去、履歴・共通境界の維持、削除テスト分類と移行修復資料を照合し、git diff --check成功。これは全機能を再検証した保証ではない。

GitHub APIの読取ではPR HEADのworkflow runs=0、check runs=0、commit statuses=0。mainはprotected=false、required contexts/checks=[]、rulesets=[]。登録CI/必須チェックが無い状態であり、CI合格とは呼ばない。設定は変更していない。

マージ後SHAから **verify/pr26-windows** を作成して検証対象を固定。最新remote mainは991e6e44e6fabed671f74a9b6c4ffcb50ae5a088（追加変更はOld/docsのプロンプト資料のみ）。検証終了後にローカルmainも通常fast-forwardで最新化し、検証ブランチへ戻した。固定対象と最新main間のsrc/catalog/package/lock/scripts/Vitest設定に差分なし。以下の実測対象はfce9ebaであり、991e6e4で再実行した結果ではない。

## 環境・実行条件

- Windows NT 10.0.26300.0、実機Windows環境。
- Node v24.16.0、C:/Program Files/nodejs/node.exe。Vitest 5.0.3は既存node_modulesを使用し、インストールなし。
- pnpm 10.34.6。開始時に現在のPowerShellからscripts/pnpm.ps1 --versionで照合。永続PATHやGit設定は変更なし。
- テストシェルはユーザーのStore版PowerShell **7.6.6**。WindowsApps/pwsh.exeから起動し、実体はC:/Program Files/WindowsApps/Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe/pwsh.exe。子プロセスPATHにもWindowsAppsを先頭指定。Codex依存7.6.5での成功に読み替えていない。
- 環境収集スクリプトがWindows PowerShell 5.1からpnpmラッパーを呼んだ際は `running scripts is disabled on this system` / `CategoryInfo: SecurityError` / `FullyQualifiedErrorId: UnauthorizedAccess` で拒否。その操作は停止し、ExecutionPolicy/ACLは変更しなかった。[生の環境記録](verification-20261009/windows-pr26/environment.json)のPnpm:nullはこの拒否による。先行の成功した版確認と区別する。

48件は[承認された対象一覧](windows-followup-scope-20261009.tsv)のaction=runを一意なpath/testで選択し、12ファイルを逐次実行。fixtureの模擬エージェント、一時Git/worktree、ダミーNode/PowerShellプロセスだけを使う。モデルquery・GUI・認証・SDK更新・インストール・ユーザーの既存プロセス操作なし。

コマンドは次の形（patternは各ファイルの承認済みtest名をregex escapeして末尾一致）。**実際の引数全文12件**は[コマンド記録](verification-20261009/windows-pr26/commands.tsv)、元のJSONと実行用スクリプトは.out/pr26-windows-fce9eba/と.out/pr26-windows-run.ps1に保存。既存のケース固有60秒/120秒等の上限を含め、タイムアウト・skip・テストコードを変更していない。

```powershell
& 'C:/Program Files/nodejs/node.exe' node_modules/vitest/vitest.mjs run $file --project=node --maxWorkers=1 --testTimeout=30000 "--testNamePattern=$pattern" --reporter=default --reporter=json "--outputFile.json=$json"
```

## ケース別結果

**対象48件成功、失敗0、対象skip/未確認0。ACL保留1件は未実施。** 全49行への対応、所要時間、終了コード、ログ参照は[ケース別結果TSV](windows-pr26-results-20261009.tsv)。名称フィルターによる対象外97件のskipは対象48件のskipではない。全回帰の再実行なし、対象の再実行も不要だった。

| ファイル                  | 対象 | 成功 | 終了コード |
| ------------------------- | ---: | ---: | ---------: |
| local-links               |    1 |    1 |          0 |
| tools/environment         |    1 |    1 |          0 |
| tools/powershell-command  |    3 |    3 |          0 |
| official/catalog-compat   |    2 |    2 |          0 |
| official/dag              |    5 |    5 |          0 |
| official/fault-injection  |   12 |   12 |          0 |
| official/owned-process    |    6 |    6 |          0 |
| official/planner-choice   |    1 |    1 |          0 |
| official/prepared-runtime |    1 |    1 |          0 |
| official/project-task     |    1 |    1 |          0 |
| official/project-vitest   |    6 |    6 |          0 |
| official/runtime          |    9 |    9 |          0 |

実行ログは[保存フォルダー](verification-20261009/windows-pr26/)。JSON reporterのケース名とstatusをTSVへ照合し、対象の欠落や重複を成功扱いしていない。DAG統合修正は24.24秒で既存60秒上限以内、Vitest依存コピー・限定実行は30.44秒で既存120秒上限以内。Store版でStart-Process Hidden/NoNewWindowのJob membership、親正常終了・取消・timeout・所有者異常終了時の子孫停止も成功。

## 修正・残作業・最終状態

テスト失敗なしのため製品コード/テスト/仕様の修正なし。型・lint・通常/headless buildの追加実行は行っていない（今回の依頼はWindows限定48件で、PR内のLinux記録とは別）。過去の全回帰結果へ今回48件を足した成功率も算出しない。

SIWCの `protects dedicated temp directory, replaces atomically and refuses a second writer` はSet-Aclを伴うため別途承認まで保留。GUI・配布物・実モデル通信・認証・インストールも未実施。通信回数0。Windows PowerShell 5.1でのpnpmラッパー拒否を解消したとは扱わない。

ローカル報告コミットは本書・結果TSV・ログのみを追加し、検証した製品ソースSHA fce9ebaを維持する。最終HEADはこの報告のコミット（最終応答にもSHAを記載）、ブランチverify/pr26-windows。新しいpush/mergeは行わない。
