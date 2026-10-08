# Windows依存以外のクラウド検証失敗の修正

対象: main / c7794e17038d2348c67d2aa36ff0f5320b8bb844に対する未コミット変更。
環境: Linux x64、Node 24.19.0、Corepack-managed pnpm 10.34.6。
実API・認証CLIは呼ばず、mock / fixtureだけを使用。

## 修正

SPEC.md §7とcatalog/models.yamlでは、新規のhaiku alias、utility、authRefreshはHaiku 5.5を使う。controllerのテスト用providerが旧Haikuだけを公開していたため、set_modelがUnknown modelで拒否されていた。5.5を追加し、変更成功も明示的に検査する。旧モデルIDは残した。Web要約・認証更新の古いモデル期待値も現在のカタログへ合わせた。製品のモデル選択・権限は変更していない。

Web要約のfixture再生はglobal fetchだけを差し替え、WebFetchが先に行うDNS検査を実行していた。既存のWebToolsExtra.fetchを使ってlookupとページfetcherを注入した。ページ取得とadapterのSSE再生を分離し、各呼出数、lookup先、送信モデルを検証する。製品のSSRF対策は変更していない。

## 境界・利用枠テストの再診断

サンドボックス内は/tmp/.gitと/workspace/.gitを仮想的な空ディレクトリとして提示する。非Gitの一時fixtureで最寄りGit identityが同一と認識されたり、HEADが読めず自動再開を拒否したりする。通常環境にはこの2つのディレクトリが存在しないことを確認した。

通常環境でproject-history / project-skills / project-memory / quota-resumeの4ファイルを再実行すると51件すべて成功した。従ってこの範囲の製品コードは変更しない。前回のonboarding記録で根本原因未解決としていた範囲を、今回切り分けた。

## 検証

変更した3ファイルは64テスト成功。typecheck、lint、build、変更ファイルのPrettier検査、git diff --checkも成功。

Windows依存7ファイル以外の215パスを選択した実行は、214ファイル成功・5ファイルスキップ、1929テスト成功・34スキップ、失敗0、終了コード0（144.02秒）。Node/renderer両projectで選択されるファイルがあるため、パス数と実行ファイル数は一致しない。スキップを成功件数へ含めない。

追加CLI --excludeが効かずWindows依存も実行された回では、214ファイル成功・7失敗・5スキップ、2018テスト成功・33失敗・34スキップ。残った失敗はすべて上記Windows Job依存7ファイル。これは全テスト成功の証拠には使わない。

Windows Job依存の7ファイル（officialのcatalog-compat、dag、fault-injection、planner-choice、project-task、runtime、service）はLinux検証から除外する。それ以外は明示的なファイルフィルターで検証する。現在のVitest workspace構成では追加のCLI --excludeが期待どおり効かず、Windows依存ファイルも選ばれることを確認したため、--excludeのみを根拠に除外成功とは扱わない。

実行方法（COREPACK_HOME=/workspace/.cache/corepackを指定し、仮想.gitのない通常環境で実行）:

```python
import subprocess

excluded = {
    f"src/main/workflow/official/{name}.test.ts"
    for name in [
        "catalog-compat", "dag", "fault-injection", "planner-choice",
        "project-task", "runtime", "service",
    ]
}
paths = subprocess.check_output([
    "rg", "--files", "src", "test", "spike", "scripts",
    "-g", "*.test.ts", "-g", "*.test.tsx",
], text=True).splitlines()
result = subprocess.run([
    "corepack", "pnpm", "exec", "vitest", "run",
    *[path for path in paths if path not in excluded],
    "--maxWorkers=1", "--testTimeout=30000",
])
raise SystemExit(result.returncode)
```

Windowsの7ファイル、PowerShell、GUI、exe作成、実認証は手元で実施が必要。Linuxでの成功をこれらの成功とは扱わない。
