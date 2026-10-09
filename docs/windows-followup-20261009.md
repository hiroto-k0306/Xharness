# Windows依存検証の別セッションへの依頼

対象リポジトリは `hiroto-k0306/Xharness`。公式only/GUI・headless共通化/Old整理/改善評価修復の作業ブランチは `docs/current-spec-archive`、基準コードは `c10cdefab647b01f077ace58f86f4bdb7bbff142`。依頼時に示すPRのマージSHAをfetchで確認し、そのリビジョンから検証用ブランチを作る。この依頼文・対象一覧以降に製品コードの変更は追加していない。

前のPCセッションでは `setup refresh had errors` により読取も失敗した。先に選択したPC環境が起動し、cwd・AGENTS.md・git status・既存ツールを読めるか確認する。失敗した場合は環境のエラーを報告し、クラウド実行をWindows実行と扱わない。

## 対象と重複

[正確なファイル・テスト名のTSV](windows-followup-scope-20261009.tsv) が実行スコープの正。49ケースはpath/testの組で一意。

| 区分                                       | 件数 | 扱い                                                                                                                                                                            |
| ------------------------------------------ | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux全回帰で失敗したWindows専用実行器依存 |   34 | DAG 4/runtime 9/fault-injection 12/planner-choice 1/prepared-runtime 1/project-task 1/project-vitest 6。Linuxでは製品が実行を拒否しexitCode null。Windowsでも成功する保証はない |
| Linux全回帰の既存Windows条件skip           |   15 | owned-process 6/catalog-compat 2/DAG 1/PowerShell command 3/environment 1/local-links 1/SIWC Windows 1                                                                          |
| 追加承認なしで実行する対象                 |   48 | TSV action=`run`。13ファイルのうちSIWCを除く12ファイル、重複なし                                                                                                                |
| ACL承認まで保留                            |    1 | TSV action=`hold-acl`。SIWCテストはtemp homeでもSet-Aclを使うため、今回は実行しない                                                                                             |

PR #25の「Windows未確認3件」はcatalog-compat 2とDAG integration correction 1で、この15skip内に含まれる。追加して52件とは数えない。旧38ファイル限定検証の「Windows3skip」も全回帰15skip内のPowerShell3件に整合するが、そのログは名前を表示していないため、別の未確認3件と断定して加算しない。

原全回帰は1757成功/52失敗/15skip。その後18移行回帰を修復し、関連9ファイル69成功、controller等39成功（重複あり）。全回帰2回目は未実行。原集計は [前段階記録](remaining-failures-regression-20261009.md)、移行修復は [最新修復記録](official-migration-regression-fix-20261009.md) を参照する。

## 環境・禁止事項

- AGENTS.md、SPEC該当節、利用可能な関連`.agents/skills`、最新remoteと現在の変更を読む。未コミット変更・ユーザーデータ・既存配布物を削除/上書きしない。dirtyならcheckout/reset/stashを強行せず、安全な隔離checkoutを使う。
- WindowsとNode.js 24 LTS（基準24.16.0、今回クラウドは24.19.0）を記録。Node 22.20以降は互換対象で、基準と異なる場合は明記する。pnpmはpackageManager指定10.34.6、Windowsは既存`.tools/node_modules/.bin/pnpm.cmd`と`scripts/pnpm.ps1`を確認する。
- 使用するpwshのversion・実体・配布形態（Store/WindowsAppsまたは通常版）を確認し、ユーザーが使う実体で検証する。Codex同梱版の結果をユーザー版成功に読み替えない。既存依存が無ければ不足を報告し、インストール・lockfile更新をしない。
- GUI起動/GUIテスト、実モデル・実API通信、SDK更新、ログイン/認証変更、インストール、ACL変更は別途明示承認なしで行わない。SIWC1件はACL承認待ちのまま別記する。fixtureが作る専用プロセス/Git一時領域だけを使用し、既存appやユーザープロセスへ操作しない。
- 全回帰2回目は実行しない。失敗を消すskip/テスト削除/一律timeout増加/非Windows許可/承認・Job containment緩和を行わない。既存のDAG60秒等は維持する。原因をコード・記録・直接関連テストで切り分ける。

## 重複なしの実行コマンド

準備済みcheckoutのリポジトリrootで実行する。先に`git rev-parse HEAD`を依頼されたマージSHAと照合し、`git status --short`で既存変更を保護する。Node/pnpm/pwshの出力と実体は結果記録へ残す。pnpm確認は版照合だけで、以下の検証は既存ローカルVitestをNodeで直接起動し自動インストールを避ける。

```powershell
node --version
.\scripts\pnpm.ps1 --version
$PSVersionTable.PSVersion
(Get-Process -Id $PID).Path
(Get-Command node).Source
(Get-Command pwsh).Source
$scope = Import-Csv '.\docs\windows-followup-scope-20261009.tsv' -Delimiter "`t"
$selected = @($scope | Where-Object action -eq 'run')
if ($selected.Count -ne 48) { throw 'Expected 48 authorized cases' }
if (@($selected | Group-Object path,test | Where-Object Count -gt 1).Count) {
  throw 'Duplicate path/test in scope'
}
if (-not (Test-Path 'node_modules/vitest/vitest.mjs')) {
  throw 'Existing Vitest is missing; do not install automatically'
}
$logDir = Join-Path $env:TEMP ('xh-windows-check-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $logDir | Out-Null
$results = @()
foreach ($group in ($selected | Group-Object path)) {
  $names = @($group.Group | ForEach-Object { [regex]::Escape($_.test) })
  $pattern = '(?:^|\s)(?:' + ($names -join '|') + ')$'
  $log = Join-Path $logDir (($group.Name -replace '[\\/]', '_') + '.log')
  & node 'node_modules/vitest/vitest.mjs' run $group.Name `
    '--project=node' '--maxWorkers=1' '--testTimeout=30000' `
    "--testNamePattern=$pattern" 2>&1 | Tee-Object -FilePath $log
  $results += [pscustomobject]@{
    File = $group.Name; Selected = $group.Count
    ExitCode = $LASTEXITCODE; Log = $log
  }
}
$results | Format-Table -AutoSize
$scope | Where-Object action -eq 'hold-acl' | Format-Table path,test,action
```

名称フィルターによる対象外skipと、対象48件の実行/失敗/環境不足を分けて集計する。選択対象の名前が0件なら成功扱いせずpattern/実行環境を調べる。PowerShell欠落やplatform条件で対象がskipされた場合も未確認のまま報告する。48対象を1回ずつ検証し、修正後の再確認は直接関連だけに絞る。

## 報告・保存

修正前後のHEAD・remote main・ブランチ、Windows/Node/pnpm/pwshの版と実体、実行した正確なコマンド、ケース別成功/失敗/対象外skip/対象skip/未実行、exit codeとログをdocsへ保存する。49件の各行に結果またはACL保留理由を対応させる。再現原因・修正差分・直接関連の再確認、未確認点、最終HEADを報告する。fixtureが生成した仮データと実測を区別し、秘密・認証値・非公開思考を記録しない。

実装修正が必要なら今回の移行差分との関係を確認して最小修正し、型/lint/整形/必要ビルドを関連範囲で行う。コミットはローカルまで。作者設定を永続変更しない。Windowsセッションでのpush/mergeは、この検証依頼からは追加で許可しない。
