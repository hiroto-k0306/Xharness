> 過去の記録：移動元 `docs/h3-job-investigation.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# H3：WindowsのJob所属と起動経路の再検証

2026-10-03。`codex/h4-file-rewind`。実API通信なし。ユーザーの再レビューを受け、Nodeの版とPowerShellの実体を分けて確認した。

## 環境と修正前の実測

Windows 11 Home（10.0.26200）。Nodeはユーザーと同じシステムの24.16.0と、互換確認用の22.23.3。PATHの最初に見つかっていたpwshはCodex同梱7.6.5だった。ユーザー側のWindowsAppsエイリアスはStore/MSIX版7.6.6を起動した。

`powershellArguments(command, true)` のC#型へ診断専用メソッドを挿入し、子が生きている間に `IsProcessInJob(process, XHarnessのjob, ...)` と `IsProcessInJob(process, NULL, ...)` を確認した。親自身の所属は全ケースtrue。起動した子のParentProcessIdは全ケースPowerShell親と一致した。親の終了後は `process.kill(pid, 0)` で生存を確認し、残存した試験用の子だけ終了した。

| pwsh              | 子の起動経路                                                | Node 22.23.3：同じJob／親終了後生存 | Node 24.16.0：同じJob／親終了後生存 |
| ----------------- | ----------------------------------------------------------- | ----------------------------------- | ----------------------------------- |
| Codex同梱7.6.5    | Start-Process -WindowStyle Hidden -PassThru                 | true／false                         | true／false                         |
| Codex同梱7.6.5    | Start-Process -NoNewWindow -PassThru                        | true／false                         | true／false                         |
| Codex同梱7.6.5    | Process.Start（UseShellExecute=false、CreateNoWindow=true） | true／false                         | true／false                         |
| WindowsApps 7.6.6 | Start-Process -WindowStyle Hidden -PassThru                 | false／true                         | false／true                         |
| WindowsApps 7.6.6 | Start-Process -NoNewWindow -PassThru                        | false／true                         | false／true                         |
| WindowsApps 7.6.6 | Process.Start（UseShellExecute=false、CreateNoWindow=true） | false／true                         | false／true                         |

Job外の6ケースはanyJobもfalseだった。Nodeの版だけでは差を説明できない。PowerShellの実体・配布形態を合わせていなかったため、前回の「Windowsで成功」はユーザー側の成功を意味しなかった。今回のWindowsApps版ではNoNewWindowと直接Process.Startも外れ、ユーザーの切り分け結果とはその点が異なる。7.6.5と7.6.6を同じ配布形態で比較した試験は未実施のため、配布形態とPowerShell版の影響を完全には分離していない。

[PowerShell公式ソース](https://github.com/PowerShell/PowerShell/blob/v7.6.6/src/Microsoft.PowerShell.Commands.Management/commands/management/Process.cs)では、Start-Processは通常ShellExecute経路、NoNewWindow等を指定した場合はCreateProcess経路を選ぶ。API経路の差は確認できるが、今回のJob離脱がWindows内部のどの処理で発生したかは未確定。Jobの所属を直接計測した結果を判断の根拠とする。

## 対処案と承認

- (a) 子を追跡して同じJobへ登録する案を推奨した。H3のプロセス終了という目的を、ユーザーが使うWindowsApps版でも保つため。まず非修飾Start-Processを対象にする。全起動経路を捕捉するにはネイティブ監視や別の起動基盤等の追加設計が必要であり、今回その保証は行わない。
- (b) 制限だけを明記する案は実装量が少ないが、通常のHidden起動でも子が残るため、推奨しなかった。
- ユーザーは「(a) 追跡を実装し、追跡外の制限も明記」を承認した。DESIGN.md §26.1 H3とBashの説明へ反映した。

## 実装と範囲

- 実行するPowerShell自身のCommandMetadataからStart-Processのプロキシを生成する。既存の引数・パラメーターセットを転記して固定しない。
- 内部でPassThruを有効にし、cmdletの出力から子を捕捉する。呼び出し側がPassThruを指定していない場合はProcessを出力しない。WhatIfでは起動・登録しない。
- プロセスのハンドルを保持して所属を確認し、Job外ならAssignProcessToJobObjectで同じJobへ登録する。登録失敗時は取得できたハンドルで子の終了を試み、固定の日本語エラーでPowerShellも終了する。昇格・別ユーザー等によりプロセスアクセス権限がない場合は、子の終了も保証できない。
- 自然終了時のJob内列挙・終了待ちと、強制停止時のJob終了管理を併用する。起動時のgateや同時実行5件の制約は変更しない。
- 直接Process.Start、モジュール名付きStart-Process、プロキシの上書き、外部ブローカー経由、登録前に生成されたJob外の子孫は追跡できず、終了を保証しない。Jobやこのプロキシは任意コマンドを隔離するセキュリティ境界ではない。

## 環境を合わせる運用

ユーザーの意見に合わせ、基準をNode 24.16.0へ更新した（.node-version、package.json、DESIGN.md §15-B、AGENTS.md、README.md）。22.20以降の22系も互換確認対象とする。型定義は22系を維持し、Electron内のNodeは別に扱う。システムPATHやインストール済みNode・pwshは変更していない。

この作業では検証プロセスのPATHの先頭へ、Node 24なら `C:\Program Files\nodejs`、Node 22ならリポジトリの `.tools/node_modules/node/bin`、そして `C:\Users\ahwri\AppData\Local\Microsoft\WindowsApps` を指定した。Codex同梱pwshが後ろにあっても、テストはWindowsApps版を使う。

再現用スクリプト（試験用の子は最後に終了する。モデル通信なし）：

```powershell
node --import tsx scripts/probe-background-job.ts <pwshの絶対パス>
# プロキシを外した場合の起動経路も診断する
node --import tsx scripts/probe-background-job.ts --unwrapped <pwshの絶対パス>
```

Nodeの実行ファイルも絶対パスで指定すると、22／24を確実に切り替えられる。スクリプトは診断用途だけで、アプリの実行モードを変更しない。

## 検証と残件

WindowsApps版で修正後の所属を直接再確認した。Node 22.23.3のHidden・NoNewWindowは同じJob=true、親終了後生存=false。Node 24.16.0でも同じ結果。直接Process.Startは両Nodeとも同じJob=false・生存=trueで、制限として記録した。生存した試験用の子は終了した。

- Job所属を親の実行中に確認するHidden／NoNewWindowの2テストと、PassThruなし・WhatIf・WorkingDirectoryの挙動を確認する1テストを追加した。Windows以外またはpwsh無しのときだけ `it.skipIf` で除外する。WindowsApps版で失敗するテストを無条件で飛ばしていない。
- WindowsApps版の子・孫の自然終了／KillShell／abort／endTurnを含む既存16テストはNode 24で成功した。最終の全体検証にも含める。
- Node 22の全体実行では、Job自然終了の既存テストが5秒で一度タイムアウトした。子の残存のアサーション失敗ではなかった。PowerShell起動・C#型生成・終了待ちを含むため、待機上限を15秒、テスト上限を20秒へ変更した。
- 既存workflow/runtimeの2ターン試験も全体実行で2回5秒に達した。一方、同じNode・pwshの単独実行では約0.2秒で成功した。この試験はPowerShellを直接起動するものではなく、FakeProviderの2ターンとローカル差分検出を行う。負荷による不安定性として、この1ケースのテスト上限を15秒へ変更した。アプリのタイムアウトや失敗判定は変更していない。
- Node 22の初回全体は792成功・2タイムアウト、自然終了テストの待機修正後は793成功・workflow試験1タイムアウトだった。該当workflow試験の待機修正後の最終結果は以下の通り。

| 検証（pwshは全てWindowsApps 7.6.6）                   | 結果                                           |
| ----------------------------------------------------- | ---------------------------------------------- |
| Node 22.23.3 `pnpm test`                              | 100ファイル・794成功、32.95秒                  |
| Node 24.16.0 `pnpm test`（rgあり）                    | 100ファイル・794成功、31.09秒                  |
| Node 24.16.0 `pnpm test`（rg無し）                    | 100ファイル・793成功・rg専用1スキップ、27.27秒 |
| Node 24 `pnpm typecheck` / `pnpm lint` / `pnpm build` | 全て成功                                       |
| Node 22 `tsc --noEmit`                                | 成功                                           |
| 変更したTypeScriptのPrettier確認・`git diff --check`  | 成功                                           |

全体テストではworker数・全体タイムアウトの上書きをしていない。rg無しはrg.exeを含むPATHエントリを除去し、Get-Commandで見つからないことを確認した。pwshはWindowsApps版を維持した。pnpmの既存onlyBuiltDependencies設定に関する警告は継続して出るが、テスト・ビルドの失敗ではない。

手元で実施が必要：修正版exeでユーザーのpwshを使用し、Hiddenによる子・孫起動を自然終了／停止／ターン終了／アプリ終了で繰り返す。追跡外の起動が必要な用途では、制限を確認し、別の監視設計を行う。今回exeの作成・更新や実API通信は行っていない。
