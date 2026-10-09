> 過去の記録：移動元 `docs/official-helper-investigation-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# 公式Codexヘルパーの起動失敗調査（2026-10-08）

最新結論：後半の「公式ソース照合と修正案」で原因を追加確認した。公式PR #51822の修正が0.162.0-alpha.20に含まれる。以前の「修正版未確認」「MCP設定由来の可能性」は当時の調査段階であり、現在の結論は末尾を参照。

## 対象と範囲

- リポジトリHEAD：27262a3bea4ff0840604a23036a1534b5345c90d。
- ブランチ：codex/loopflow-workflow-ui。開始時の作業ツリーはclean。
- 配布コード：6ae006ae024fc22e62e102e87bee7d384460c767。
- 公式Codex：0.162.0-alpha.2、bin/9691020b546a15b2。
- 調査環境：Windows（直前の検証記録では10.0.26300）、Node 24.16.0、PowerShell 7.6.5（Codex同梱版）。Store版pwshでの確認ではない。
- SPEC §15と実装の公式接続設定を照合。ログ・プロセス一覧の読み取りだけで、追加のモデル通信は0回。
- 資格情報の読み取り・コピー、ACL変更、sandbox変更、プロセス終了、push、mergeは行っていない。

## 判明した直接原因

公式CodexのWindows sandboxセットアップが、共有ランタイムのnode_repl.exeに対するread/execute検証で失敗した。ACL更新対象を開く段階でWindowsの共有違反（os error 32）が返り、setup refreshがexit 1になった。

根拠は、CODEX_HOME（今回C:/Users/ahwri/.codex）の `.sandbox/sandbox.2026-10-08.log`。元ログ全体をリポジトリへコピーせず、該当する固定エラーだけ記録する。

```text
runtime read/execute validation failed:
validate runtime read/execute access on <Codex runtime>/cua_node/3dd31cfff853001c/bin/node_repl.exe:
open ACL target for root-only update:
プロセスはファイルにアクセスできません。別のプロセスが使用中です。 (os error 32)
setup error: setup refresh had errors
setup refresh: exited with status ExitStatus(ExitStatus(1))
```

| ログの時刻（JST） | セットアップのcwd                       | 対応する失敗                                                      |
| ----------------- | --------------------------------------- | ----------------------------------------------------------------- |
| 13:04:22          | .out/loopflow-live-20261008/codex-build | 通常入力のCodex実装、request a57be7b2-78cc-4a30-aec3-38bb4d8bd87b |
| 13:11:17          | 隔離homeのworkspace-YiORQA              | 合成診断、request a4cd1400-4102-4f1e-b197-abe2025593c9            |

どちらも同じruntimeファイル・os error 32。保存済みcommandExecutionのexit -1、duration 0、unifiedExecStartup、および合成診断のhelper_unknown_errorと一致する。XHarnessの操作承認はallowed / explicitで、承認拒否が原因ではない。対象add.mjsの読み取り開始より前の失敗である。

ログにはworkspaceのwrite ACEと.git保護設定も記録されているが、この調査で再実行・変更していない。これらが全て成功したことや、以降のファイル編集が可能なことまで保証しない。

## 使用中プロセスの確認と限界

調査時点のGet-CimInstanceによる一覧では、同じnode_repl.exeを使用するPID 23336、27084、4632、10312が存在した。直接の親、または親のnode.exeをたどると、いずれもCodexデスクトップのcodex.exe（PID 26480）とChatGPT.exe（PID 25760）配下だった。XHarnessのメインPIDは5952で、この親子関係には含まれない。

このため、CodexデスクトップとXHarnessの公式App Serverが共有するruntimeの使用中に、setup refreshがACL対象を開けなかったことが有力な説明となる。ただし一覧は失敗後の状態であり、当時の特定のロック保持者・共有モードを採取したわけではない。特定のPIDが原因だったと断定しない。公式CLIの版固有の不具合かどうかも未確定。

XHarnessは実装/fixでcode_mode_hostとunified_execを有効にし、workspace-write・untrusted・networkAccess:falseを維持している。今回、これらを無効化する回避や別sandboxへの切替は行わない。

## 次の再確認

1. 作業を保存し、Codexデスクトップの処理が終了した状態で通常終了する。現在のエージェント自身もそのアプリに属するため、この調査中に終了しない。
2. XHarness側の保存済み失敗を成功へ変更せず、ユーザーの次の実通信許可の範囲で新しい小課題を1回だけ実行する。
3. 同じsandboxログでos error 32が消えたか、独立テスト・レビューまで到達したかを別々に記録する。失敗が残れば再試行を重ねず、公式側へ秘密を含まない診断情報を準備する。

Codexの通常終了後に直るかは未検証。アプリを閉じるだけで必ず解消するとは説明しない。実装修正・回帰テスト・再ビルドは今回行っていない（コード変更なし）。この文書のみ追加し、ローカルコミットは行っていない。

公式資料：[Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)。公式資料もsandbox境界とセットアップログによる切り分けを説明するが、このos error 32固有の原因・修正は掲載箇所で確認できなかった。今回の直接原因はローカルの実ログに基づく。

## 続行調査：Codex起動中の併用（同日）

ユーザーの「調査続けて」を受け、HEADと未コミットの本報告書を確認して保護した。引き続きモデル通信0回、認証操作0回。コード・SPECは変更していない。

### XHarness以外でも発生

公式CLI 0.162.0-alpha.2への `codex sandbox windows --help` は、ヘルプ表示ではなくsandbox処理へ進んだ。調査者が読み取り専用と判断したのは誤りだった。このコマンドはexit 1で終了し、任意のテストコマンド・モデル処理は実行していないが、セットアップ処理自体は起動している。

14:40:20 JSTの公式sandboxログは、同じnode_repl.exeでのos error 32、setup refreshのexit 1、processed 0 write rootsを記録した。その後 `read-acl-only mode: applying read ACLs` と `read ACL run completed` も記録されている。したがって「続行調査はACL処理を一切起動していない」とは扱わない。どのACLが変化したかの前後比較はなく、変更ゼロも保証できない。予期しない副作用をユーザーへ報告し、sandboxコマンド・設定変更・再試行を停止した。前節の「ACL変更なし」は続行調査前の範囲の記録である。

この再現は、XHarnessの承認実装やモデル選択が無くても公式CLIの実行準備で同じエラーになる証拠である。Codex起動中なら全環境で必ず失敗する、という一般化はしない。

### 分離案を検討した結果

- XHarnessのAppServerRpcは専用stdio子プロセスであり、既存のCodex daemonへ接続していない。プロセスだけの分離は既にある。
- runtimeEnvironmentはUSERPROFILE、LOCALAPPDATA、CODEX_HOME等を引き継ぐ。隔離XHARNESS_HOMEは公式Codexのhomeや共有runtimeを分離しない。
- ユーザーconfig.tomlのmcp_servers.node_repl.commandが、失敗した共有exeを指している。XHarnessはconfig/read後、thread/startの上書きで各MCPをenabled=falseにしている。公式ドキュメントにもenabled=falseによる無効化はあるが、それがsandbox setupのruntime検証対象からパスを除く保証は確認できなかった。
- 公式setup exeの静的文字列にはLOCALAPPDATA、OpenAI/Codex、runtimes、.cache/codex-runtimesとruntime read/execute validationがある。MCP設定だけが原因であるとは確定できず、MCP commandの変更だけで解消するとも言えない。バイナリ文字列は完全な実装仕様ではない。
- 現行CLIのapp-server --helpには --code-mode-host URLがある。ただしremote hostにしてもWindows execのsandbox準備が不要になる証拠は無い。認証や安全境界の検証を省略して採用しない。
- 公式設定リファレンスでは、runtime検証の共有違反を回避する専用設定や、共有node_repl.exeの置き換え先を指定する解決方法は確認できなかった。CLI内部にはjs_repl_node_pathという文字列があるが、今回のnode_repl.exe検証と同じ用途とは未確認で、推測で設定しない。

資格情報コピーを伴うCODEX_HOME分離、LOCALAPPDATAの偽装、共有exeの移動・置換、sandboxの無効化/切替は行わない。exeだけを複製しても設定・runtime探索先は同じ可能性があり、解決策として提供しない。

### 対応方針と未完了

併用の問題は、公式Windows sandbox setupが使用中の共有runtimeを処理できない点まで切り分けられた。公式ヘルパーが実行中ファイルへのACL検証・更新を適切に扱う修正、または公式に対応したruntime分離方法の確認が必要。特定のCreateFile共有フラグ等が欠けているとは、ソースを確認できていないため断定しない。

XHarness側では、native起動失敗を一般的なno-changesと分けて表示・停止する改善は可能。ただし併用そのものの修復ではない。自動再試行や暗黙sandbox切替は採用しない。今回の依頼は調査のため、実装・テスト・コミット・配布更新は行っていない。Codexを閉じることは恒常的な製品要件としない。

参照：[公式設定リファレンス](https://learn.chatgpt.com/docs/config-file/config-reference)とローカルCLIのapp-server --help。公式資料に無い内部設定は公開対応策として保証しない。

## 公式ソース照合と修正案（同日・追加調査）

### 原因を裏付けた証拠

1. 公式の[PR #51822](https://github.com/openai/codex/pull/51822)は、実行中のEXE/DLLをMAXIMUM_ALLOWEDで開くと共有違反になる問題を修正している。2026-10-07 20:47:11 UTC（10月8日05:47:11 JST）にマージ済み。コミットはdd12f892f1b857e5161abd33a2967125b265d550。
2. 使用中の[0.162.0-alpha.2のacl.rs](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.2/codex-rs/windows-sandbox-rs/src/acl.rs)では、inheritance == 0の対象をファイル・フォルダーの区別なくMAXIMUM_ALLOWEDで開く。権限が既に足りていて更新不要かを調べる前に、このopenが実行される。既存ログの固定エラー文言とも一致する。
3. 修正後はMAXIMUM_ALLOWEDをディレクトリだけに限定し、ファイルのACLをまず読み、必要な場合だけREAD_CONTROL | WRITE_DACで更新する。既存の拒否ACE・継承しない付与・null DACLの扱いを維持する。公式PRには、runtimeファイルをFILE_SHARE_READで開いたまま修復・再検証し、拒否権限が保持される回帰テストもある。当方でそのRustテストを実行したわけではない。
4. この端末の実ファイルにも、書き込みを行わないCreateFileW比較を実施した。共有条件は全てFILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE、OPEN_EXISTING、FILE_FLAG_BACKUP_SEMANTICSで固定。成功ハンドルは直ちに閉じ、SetSecurityInfo・WriteFile・プロセス停止は呼んでいない。

| 要求アクセス              | この端末のnode_repl.exeでの結果 |
| ------------------------- | ------------------------------- |
| READ_CONTROL              | 成功、Win32 error 0             |
| READ_CONTROL \| WRITE_DAC | 成功、Win32 error 0             |
| MAXIMUM_ALLOWED           | 失敗、Win32 error 32            |

この比較時もCodexデスクトップ配下に同じnode_repl.exeを使用するプロセスが存在した。直接原因の共有違反と、公式修正が対象にしている過剰なアクセス要求がこの端末でも一致する。インストール済みhelperの機械語を公開ソースへ完全対応付けしたわけではなく、特定のロック保持PIDも未確定だが、単に「起動中だから使えない仕様」と扱う根拠はない。

### MCP無効化・home分離では解決を保証できない理由

[setup_runtime_bin.rs](https://github.com/openai/codex/blob/rust-v0.162.0-alpha.20/codex-rs/windows-sandbox-rs/src/setup_provisioning/setup_runtime_bin.rs)を読んで確認した。setupはLOCALAPPDATAからOpenAI/Codex/runtimesを組み立て、ensure_runtime_tree_readableでその配下を再帰検査する。MCP一覧に依存して検査対象を選んでいるわけではない。MCPのenabled=falseやCODEX_HOMEだけの分離では、この共有runtimeの走査を取り除けない。以前のMCP由来の仮説は、修正の根拠から外す。

### 修正を含む公開版

GitHub Releasesと各タグのacl.rsを取得して比較した。alpha.20は修正コミットの子孫（compare: ahead 22 / behind 0）で、ファイル種別の判定も実際に含む。

| 版                            | 今回のファイル種別判定による修正 |
| ----------------------------- | -------------------------------- |
| 0.162.0-alpha.2（使用中）     | なし                             |
| 0.162.0-alpha.17.1            | なし                             |
| 0.162.0-alpha.18.1            | なし                             |
| 0.161.0（調査時の直近安定版） | なし                             |
| 0.162.0-alpha.20              | あり（公開済みプレリリース）     |

[alpha.20リリース](https://github.com/openai/codex/releases/tag/rust-v0.162.0-alpha.20)の公開時刻は2026-10-08 02:25:14 UTC。公式APIが返したx64 Windows CLI zipのSHA256はea91b00ba6d6b39b30283648b0d47d75da34bb3e1a28de5fa271ab15cd7935af。これは公開メタデータの値で、今回バイナリのダウンロード・展開・実行・ハッシュ実測はしていない。

### 推奨する修正案

**A. XHarness専用に、修正済み公式CLI一式を版固定して配置する。**

- 最初の検証候補は0.162.0-alpha.20。Codexデスクトップのインストール先や同梱exeを上書きしない。codex.exeだけ・sandbox helperだけを異なる版へ差し替えず、必要なhelperを含む同じ公式版一式として扱う。
- 既存の「Codex実行ファイル」設定でそのexeを明示選択する。資格情報ファイルのコピーやCODEX_HOMEの偽装は行わず、公式App Server自身が既存の正規認証を扱う。XHarnessから認証内容を抽出しない。
- 現行のworkspace-write、untrusted承認、networkAccess:false、個別操作承認、quota/課金経路確認は維持する。新CLIがこれらを解釈できない場合は停止し、設定を弱めて通さない。
- デスクトップアプリと異なる更新周期でCLIを管理できるため、アプリの更新で実行パスが消える問題にも対処しやすい。ただし自動ダウンロード・自動切替はこの案に含めない。
- プレリリースのため、この端末で下記を通すまで採用成功とは扱わない。安定版だけを使う場合は、今回の修正が含まれる安定版を待って同じ検証をする。未検証の旧版へ戻す案は第一候補にしない。

**B. XHarnessの失敗分類を直す。Aと併せて行う。**

- 現状codex.tsはcommandExecution失敗を証跡へ記録するが、turnがcompletedならcompletedを返し得る。その後runtime.tsの差分確認でno-changesになるため、ヘルパー起動失敗が画面で埋もれる。
- item/completedのcommandExecutionがfailedかつsource=unifiedExecStartupなら、native-exec-startup-failedとしてphaseを失敗終了する。通常のコマンド非ゼロ終了や、正常な変更なしと区別する。最終turn.itemsだけに存在する場合も同じ判定を行う。
- request/session/turn/itemに紐付け、レシート・LoopFlow・履歴に「公式Codexのコマンド実行準備に失敗」と表示する。os error 32や共有runtimeとの因果は固定の安全なエラー分類で確認できた場合だけ補足し、sourceやexit -1だけから断定しない。
- 一般利用の本文保存を有効化したり、他セッションのsandboxログを無条件に収集したりしない。自動再送・自動fallbackは行わず、変更途中なら差分を保護して停止する。
- SPEC §15の失敗時停止に沿う明確化として実装する。配布CLIの版固定・配置方法を製品仕様に追加する場合は、実装前に人間へ確認してSPECを更新する。

### 実装後に必要な検証

1. 模擬イベントで起動失敗・通常のコマンド失敗・正常な変更なし・遅延/重複イベント・最終itemsのみの証跡を区別する。起動失敗後に独立テスト/レビュー/修正ループへ進まないことを確認する。
2. 公式CLI一式の出所・版・ハッシュを確認し、CLI引数とApp Serverの承認・sandbox・quota応答の互換性を確認する。
3. **Codexを起動したまま**、隔離した課題で読み取り、許可範囲内の編集、範囲外書き込み拒否、.git保護、ネットワーク制限を確認する。sandbox実行は公式セットアップによるACL処理を伴うため、実行前に今回の調査とは別に許可範囲を確認する。現在は未実施。
4. 前段合格後、承認済みの通信予算内でCodex実装→独立テスト→Claudeレビューを1課題だけ通す。失敗した場合は分類とログを確認して停止する。今回はモデル通信・インストール・配布更新は実施していない。

本追加調査は公式ソース/リリースの読み取りとハンドルopen/closeの比較のみ。前節で記録したsandbox --helpの副作用は再発させていない。コード・SPEC・認証・OS設定・アプリの実行パスは未変更。報告書のみ更新し、未コミット。

## 2026-10-08 alpha.20実通信による確認

公式の0.162.0-alpha.20を全helperと一緒に別フォルダーへ展開し、XHarnessの画面からbinフォルダーを固定指定した。Codexデスクトップ/node_repl起動中でも、限定承認したGet-ContentがunifiedExecStartup・205ms・終了0で完了し、実装・独立テスト・Claudeレビューまで通った。以前のalpha.2の失敗を今回の成功に置き換えて隠さず、CLI版・配布物・予算と使用量を[追確認報告](codex-prerelease-live-20261008.md)に記録した。ACLの手動変更・権限緩和・資格情報のコピーは行っていない。
