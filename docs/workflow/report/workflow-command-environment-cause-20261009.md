> 過去の記録：移動元 `docs/workflow-command-environment-cause-20261009.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 公式Codexのコマンド未検出と早期timeoutの原因調査

2026-10-09、Windows。調査対象HEAD e45593e5782b8de1a3c379cc5c44ada585017789、インストール済みソース40cb47d、公式Codex指定0.162.0-alpha.20。利用者の「原因調査して」に対応。SPEC §15の公式接続・工程制限を確認。開始時の作業ツリーはクリーン。

対象workflowは4adbd58e-9841-4a58-8ee3-5ee049beb64c、Codex request IDは05d022c3-1d9e-444a-a2ed-116936aac889。約47.6秒でtimeoutし、編集・テスト・レビューに至らなかった。監視結果は[前報](workflow-reexecution-monitor-20261009.md)。今回の追加モデル通信・認証操作は0回。製品コード、設定、資格情報、権限、インストールを変更していない。

## 確認できた原因

1. **PATHEXTの欠落**。AppServerRpcはruntimeEnvironment()をspawnOwnedProcessへ渡す。workspace.tsの許可リストはPATHを残す一方、PATHEXTを含まない。Windows PowerShellの名前による実行ファイル探索にはこの差が影響する。PATHにnodejs・Git・pwshの実在するディレクトリがあっても、拡張子を省いたnode / git / pwshが見つからない状態を、同じ管理プロセスの起動経路で再現した。PATHだけの問題や未インストールとは説明できない。
2. **PowerShell 7のモジュール探索先が5.1へ流入**。owned-process.tsの管理プロセスはpwsh -NoProfileで起動し、CreateProcessWに環境ブロックを指定せず、その時点の環境を子へ継承する。PowerShell 7は起動時にPSModulePathへ自身のModules等を追加する。それを後続のWindows PowerShell 5.1が継承すると、Microsoft.PowerShell.Utilityの探索が壊れ、Get-FileHashが未検出になる。今回の保存コマンドはWindows/System32/WindowsPowerShell/v1.0/powershell.exeを使用していた。管理用pwshのUtility manifestはModuleVersion 7.0.0.0、CompatiblePSEditions Core。ダミーの後続シェルだけでPSModulePathをWindows PowerShell標準Modulesへ置き換えるとGet-FileHashが復帰した。
3. **並行承認のタイマー重複計上**。既に停止中かを管理せず、pauseTimer呼出のたびに同じ経過時間を残量から差し引く。8並行承認で120秒の残り時間が誤って短くなることを実ソース抽出の偽時計で確認済み。詳細は前報。ツール未検出とは別の製品不具合で、未検出を解消しても修正が必要。

## 通信なしの切り分け

Node 24.16.0、管理用pwsh 7.6.5（C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe）、後続Windows PowerShell 5.1。Store版pwshの確認ではない。scripts/pnpm.ps1経由でtsxを実行。モデル、SDK、実App Serverは起動せず、管理プロセスの子をNodeのダミーへ置き換えた。ACLやsandboxを変更していない。

pnpmのnode.ps1 shimがnode未検出を隠すため、probeに限りPATHからnode_modulesの項目を除外した。既存のnode.exe・git.exe・pwsh.exeの探索ディレクトリは残した。表の値はGet-Commandによる検出結果で、モデルによる作業成功ではない。

| ダミー起動条件                                  | node  | git   | pwsh  | Get-FileHash | 終了コード |
| ----------------------------------------------- | ----- | ----- | ----- | ------------ | ---------- |
| 現行runtimeEnvironment + 現行管理プロセス       | false | false | false | false        | 0          |
| 上記 + PATHEXTを子へ渡す                        | true  | true  | true  | false        | 0          |
| 上記 + 後続5.1のPSModulePathを標準Modulesへ限定 | true  | true  | true  | true         | 0          |

probeは.out/probe-owned-environment.ts。直接spawnの比較は.out/probe-environment-matrix.ts。通常環境でもPowerShell 7のPSModulePathを引き継いだ5.1ではGet-FileHashが未検出となり、5.1側だけのモジュール経路補正で復帰した。管理プロセスへPSModulePathを渡すだけでは、7の起動時に再追加されるため解消しないことも確認した。

実App Server／sandbox内の環境値は今回も直接採取していない。したがって公式CLI内部の全環境処理を検証したとは扱わない。ただしXHarnessの同じ起動経路で、実ログの4項目未検出を再現し、二つの環境差だけで復帰することを確認した。CLI破損・権限不足を原因と断定する根拠はない。

## 修正案（今回は未実装）

- 安全なWindows実行環境としてPATHEXTを引き継ぐ。APIキー・接続先・Node注入等を除く現行境界は維持し、process.envを丸ごと渡さない。
- 管理用PowerShellが生成したモジュール探索先を公式ヘルパーの子へ持ち込まない。管理処理と子の環境を分離し、各PowerShellが自身の版に対応する探索先を初期化できるようにする。5.1の経路を製品全体へ固定する対応は避ける。
- 承認待ち数を管理し、最初の待機開始だけで時計を止め、最後の待機終了だけで再開する。並行・拒否・取消・期限切れ・自動許可を偽時計で検証する。
- ダミー管理プロセスでexe探索、7→5.1のモジュール継承、終了時の子孫回収を回帰検証する。その後、別途許可された実通信で実App Server内の検出と工程完了を確認する。

[公式設定仕様](https://learn.chatgpt.com/docs/config-file/config-reference)にはshell_environment_policyによる継承・フィルターがある。ただし最新版の仕様をalpha.20の動作確認に読み替えず、inherit=allによる境界の緩和では解決しない。

今回は原因調査のみ。製品修正・回帰全体・再インストール・追加の実通信は未実施。調査結果だけをdocsへ追加し、既存アプリと証跡を保全した。
