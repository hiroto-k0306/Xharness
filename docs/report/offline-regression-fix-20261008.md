> 過去の記録：移動元 `docs/offline-regression-fix-20261008.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../Spec.md)から参照してください。この整理では試験を再実行していません。

# オフライン回帰の修正と再検証（2026-10-08）

対象checkoutはC:/Users/ahwri/Documents/Codex/2026-10-05/task/Xharness-connections。mainのa149b81f3906734a29a909f53d32a24c2ff43a68からcodex/offline-regression-git-boundaryを作成した。D:/AIwork/Xharnessの別checkoutは変更していない。開始時の未コミット報告書postmerge-regression-20261008.mdは内容を保護し、前回結果として残す。

## 原因と修正

前回の全回帰は2,081件中9件が失敗した。合成repoと子worktreeを作るGitはシステムのcore.autocrlf=trueを引き継ぎ、検査のGitはシステム設定を無効化していた。この不整合で作成直後のworktreeがdirtyと判定され、モデル処理に進む前に模擬DAGが停止していた。

合成repoと管理worktreeの作成・open・操作に、既存のworkflowGitEnvironment/PolicyArgsを適用した。管理worktreeの変更操作前には、ローカルの実行設定を既存のinspectで検査する。外部設定やhooksを再有効化したり、利用者のGit設定を変更したりする修正ではない。SPEC.md §15の所有する合成workspace・native DAG無効という境界を維持した。

追加テストは、外部autocrlf=trueでも子worktreeがcleanかつLFで作成され、変更のcommitと統合が成功し、外部設定が変わらないことを確認する。また、作成前にローカルincludeが追加された場合は拒否し、子worktreeを作らないことを確認する。

通常lintの5エラーは保存済みの.out補助スクリプトだけだった。生成・検証出力の.outをESLintのignoreへ追加した。src・test・scriptsの検査は維持している。format:checkの失敗は既存の修正サイクル報告書の余分な空行を整形した。

## ローカルコミット

- c697f01：合成repo/worktreeのGit設定境界を検査と統一（5ファイル、120追加・47削除）
- b5506ca：保存済み検証出力をlint対象から除外
- 15399a203607368e3491723220c000355cfc4e96：既存報告書の空行を整形

今回の検証対象ソースは15399a2。各コミットはCodex <codex@local>をそのコマンドに限って指定し、永続Git設定は変更していない。文書の保存コミットは検証後に追加する。push・mergeはしていない。

## 環境と実行範囲

Windows。全VitestはユーザーのNode v24.16.0（C:/Program Files/nodejs/node.exe）を明示して実行する。pnpmラッパー・変更範囲テスト・型/lint/整形/buildはcheckoutのNode v22.23.3（.tools/node_modules/.bin/node.exe）。PowerShellはCodex同梱7.6.5で、WindowsApps/Store版を検証したものではない。rgあり。OSの権限、永続PATH、所有者は変更していない。safe.directoryは承認済みの当該checkoutだけをGitコマンドに指定した。

package.jsonと既存の手順を確認し、scripts/pnpm.ps1を使用した。全回帰は既定testと同じVitest引数を用い、Vitest自身のNodeだけ24.16.0に指定した。既定の除外とmaxWorkers=1/testTimeout=30000を維持し、新たなテスト除外・スキップを追加していない。

```powershell
.\scripts\pnpm.ps1 test src/main/workflow/official/dag.test.ts src/main/workflow/official/worktrees.test.ts src/main/workflow/official/workspace.test.ts src/main/workflow/official/fixtures.test.ts
.\scripts\pnpm.ps1 exec 'C:/Program Files/nodejs/node.exe' node_modules/vitest/vitest.mjs run --exclude=spike/.out/** --exclude=.tools/** --exclude=dist/** --maxWorkers=1 --testTimeout=30000
.\scripts\pnpm.ps1 typecheck
.\scripts\pnpm.ps1 lint
.\scripts\pnpm.ps1 format:check
.\scripts\pnpm.ps1 build
.\scripts\pnpm.ps1 build:headless
```

FakeProvider・SDK/App Serverモック・fixture・ダミーCLI・一時Gitのみを使用する。localhostの模擬OAuth/MCPは実認証ではない。実AI送信、公式CLIのログイン/更新、認証ファイルの編集・コピーは0回。

## 結果

変更範囲はNode22で4 suites・26テストすべて成功、127.71秒。模擬DAG11件もすべて成功し、前回失敗した9件を修正できた。追加の2件を含み、全回帰と件数を合算しない。

全回帰はNode24で終了0、226 suites・2,083テストすべて成功、572.49秒。失敗・スキップは0件。node/rendererの重複実行を含むsuite数で、ユニークなファイル数とは区別する。通常の単一課題、自動判別、承認、停止、/compact、履歴、worktree、予約、子引き継ぎ、画像、provider変換、jsdom画面回帰を含む今回の結果であり、過去の成功件数の流用ではない。

typecheck・通常lint・format:check・通常build・headless buildはすべて終了0。報告書追加後のformat:checkも終了0（.out/regression-fix-20261008-final-format.log）。生成されたビルドは検証用で、配布物として公開していない。

ログは.out/regression-fix-20261008-focused.log、-full-node24.log、-typecheck.log、-lint.log、-format.log、-build.log、-headless-build.log。静的検査とbuildの終了コードは同接頭辞の-static.json/-build.jsonに記録した。

## 未確認・未実施

全Vitestにはjsdomの画面回帰を含むが、Electron/Playwright、portable/recovery、アプリ起動、インストーラー生成は実施していない。既知の隔離環境でのElectron FATAL/0x80000003を繰り返す起動は避けた。実通信でのモデル選択・認証更新、Store版pwsh、rgなしの再実行は未確認。native DAGは引き続き無効であり、模擬DAG成功を実通信成功として扱わない。
