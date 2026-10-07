# マージ後のオフライン回帰検証（2026-10-08）

対象：mainのマージcommit a149b81f3906734a29a909f53d32a24c2ff43a68（PR #14）。検証checkoutはC:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness-connections。開始時clean、feature/official-workflow-single-taskの746b954を保護し、検証時だけorigin/mainをdetached checkoutした。D:/AIwork/Xharnessは古い別checkoutのため変更していない。

## 環境と通信範囲

Windows、検証Node v22.23.3（checkoutの.tools/node_modules/.bin/node.exe）、ローカルpnpmをscripts/pnpm.ps1から実行。PowerShell 7.6.5はCodex同梱版。Node24およびStore版pwshで再検証したものではない。Gitシステム設定のcore.autocrlfはtrue（C:/Program Files/Git/etc/gitconfig）。設定・PATH・ACLの永続変更はしていない。

package.json、Vitest/Playwright設定と認証・プロバイダー関連テストを確認した。SDK/App Serverは注入モック、HTTPはfixture/mock、認証更新は偽の実行器、Windows CLI経路は一時dummy cmd shimを使う。MCP/OAuthのlocalhost試験は実認証ではない。spike実通信コマンド、公式CLIによる実ログイン/更新、既存の資格情報のコピー・改変、アプリ起動は行っていない。実AI送信は0回。

## 結果

全Vitest回帰は終了1。225 test suitesのうち224成功・1失敗、2,081テストのうち2,072成功・9失敗。所要543.62秒。失敗9件はすべてsrc/main/workflow/official/dag.test.ts（模擬DAG）で、既定のpnpm testから除外やスキップを加えていない。Vitest node/rendererの重複実行を含むsuite数で、ユニークなファイル数とは区別する。

通常の単一課題、自動判別、承認/拒否、停止、/compact、履歴、worktree、予約、子引き継ぎ、provider形式変換、画像等を含む全Vitestの結果であり、過去の検証件数の再利用ではない。

型チェック、通常build、headless buildは終了0。通常lintは既存.out補助ファイルで5エラーになり終了1。eslint . --ignore-pattern '.out/**'でソース範囲は終了0。format:checkはdocs/fix-cycle-fault-injection-20261007.mdの整形で終了1。合格に見せるためファイルを削除・除外したり、本体の設定を変えたりはしていない。除外したlintの補助実行は通常lintと別結果として扱う。

## 実行コマンド

- scripts/pnpm.ps1 test
- scripts/pnpm.ps1 typecheck
- scripts/pnpm.ps1 lint
- scripts/pnpm.ps1 format:check
- scripts/pnpm.ps1 build
- scripts/pnpm.ps1 build:headless
- 補助lint：scripts/pnpm.ps1 exec eslint . --ignore-pattern '.out/**'

ログ：.out/merged-regression-20261008-tests.log、_-typecheck.log、_-lint.log、_-lint-source.log、_-format.log、_-build.log、_-headless-build.log。

## 再現した失敗と切り分け

模擬DAGの正常・取消・再開等に9失敗。独立タスク並列実行の1件を単独でも再実行し、dag-child-uncertainを再現した（.out/merged-regression-20261008-dag-focus.log）。合成repoのみの追加診断で、子worktreeのinspectがclean:false、モデルphaseのcallsは空のまま止まることを確認した。通常Gitのstatusは空だが、workflowGitEnvironment/PolicyArgsを使ったstatusではadd/multiply/combineと各testの6ファイルが変更扱いになる（.out/merged-regression-20261008-dag-probe.log）。

作成経路dag-fixtures.ts/OfficialWorktrees.gitはシステムのcore.autocrlf=trueを引き継ぐ一方、gitWorkspace.inspectはシステム設定を無効化する。作成直後の子worktreeと検査で改行前提が異なる。これはテスト負荷の一過性だけではなく設定境界の不整合。ネイティブDAGが無効であることは維持されており、模擬DAGの失敗を実通信の失敗・成功へ読み替えない。

追加の切り分けとして、試験起動プロセスだけにGIT_CONFIG_NOSYSTEM=1/GIT_CONFIG_GLOBAL=NULを設定してDAG11件を実行したが、2成功・9失敗のままだった（.out/merged-regression-20261008-dag-isolated-config.log）。環境変数はコマンド終了時に元へ戻し、永続Git設定は変えていない。OfficialWorktrees.gitがruntimeEnvironmentでこれらの変数を落とすため、起動プロセスの設定だけでは作成経路は統一されない。この補助試験を全回帰の成功として扱わない。

修正候補は、管理する合成repo/worktreeの作成も検査と同じGit環境・引数にそろえ、Windowsのautocrlf=true環境で回帰すること。安全のため無効にした外部設定を再有効化したり、利用者のGit設定を変更したりしない。今回は検証依頼なので製品コードを修正していない。

## 未実施

Electron/Playwright GUI、portable/recovery、配布物の再生成は未実施。既知の隔離環境でのElectron FATAL/0x80000003を繰り返す起動は行わず、jsdomの画面回帰を全Vitest内で検証する。実通信・認証更新・モデル判別精度・最新配布版起動は未確認。コードcommit、push、merge、インストール更新は行っていない。

## 保存状態

検証終了後、元のfeature/official-workflow-single-task（746b954）へ戻す。対象mainのa149b81とこのbranchは実装コードが同じで、main側の別変更はプロンプト文書。検証したリビジョンはa149b81として記録する。追跡ファイルの差分はなく、この報告書だけが未コミット。今回はローカルコミット・pushは行っていない。
