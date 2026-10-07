# 公式workflowの計画担当表示（2026-10-07）

対象は `feature/official-workflow-single-task`、開始HEAD `f7282b5b484e9886662e1cff8f1a3f2cf4b48ea4`。開始時の作業ツリーはclean。現行根拠はSPEC.md §15、AGENTS.mdを確認。repositoryと確認した親2階層に `.agents/skills` は存在しなかった。DESIGN.mdの歴史仕様は今回の判断に使用していない。

## 変更

承認画面の各課題で、実装担当とレビュー担当をラベル付きの別カードとして表示する。provider・完全なモデルID・effort・選択理由を表示し、狭い幅ではカードを縦に並べ、長いIDを省略せず折り返す。

新しい記録は保存済みplanのassignee/reviewerをそのまま読む。メインモデルの現在の選択やカタログを参照しない。表示は計画や承認digestを書き換えず、承認コマンドも保存されたid/digestのまま。

reviewerのない旧記録は、サービスの再開時と同じ `impliedRecordModels` / `record-compat.ts` を使用する。v1の版別固定値は実装担当と別providerのClaude Opus 5.5 high / GPT-6 Luna lowで、「計画に記録なし：記録形式v1の固定設定」と出典を明示する。固定定義のない版は全項目を未確定とし、推測で補わない。effortがnull/欠測なら既存実行方針と同じserver defaultとし、指定なしを明示する。モデル選択・許可対象・認証・保存形式・実行経路は変更していない。

## 検証

Windows、PowerShell 7.6.5（Codex同梱 `C:/Users/ahwri/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe`）。ローカルpnpm経由はNode 22.23.3、直接整形・対象lintはシステムNode 24.16.0。インストールや永続PATH変更なし。

- `scripts/pnpm.ps1 test src/renderer/components/OfficialWorkflowPanel.test.tsx src/main/workflow/official/planner-choice.test.ts`：最終18件成功（2ファイル）。保存済み担当、両方向の旧固定設定、不明な版、server default、選択変更後の表示安定、記録不変、承認digestの送信を含む。fake/mockのみ。`.out/plan-assignments-focused-final.log`。
- `scripts/pnpm.ps1 typecheck`：最終成功。`.out/plan-assignments-typecheck-final.log`。
- 変更したTSX3件のESLint：成功。`.out/plan-assignments-lint-focused.log`。
- 変更したTSX3件/CSS1件のPrettier：成功。`.out/plan-assignments-format.log`。最初のpnpm exec prettierはコマンド未解決となり、既存ローカルPrettierを直接実行して整形した。
- 全体lint：失敗。既存の未追跡診断スクリプト `.out/fixcycle-live-driver.mjs` のunused readFileと `.out/offline-electron-preparation.mjs` のrequire import、計2件。今回は変更しない。`.out/plan-assignments-lint.log`。

## 配布・未検証

`scripts/pnpm.ps1 package:dir --config.directories.output=.out/plan-assignments-dist` を既定の隔離環境で1回実行。iconのtsx 4.23.15評価中、`os.userInfo` / `uv_os_get_passwd` / ENOMEM / errno -4057でexit 1。既知の実行環境問題が再発し、配布生成へ到達しなかった。実メモリ不足やACLを原因と断定しない。`.out/plan-assignments-package.log`。

独立の `scripts/pnpm.ps1 build` も1回実行しexit 1。esbuildが祖先directoryをAccess deniedとして扱い、electron.vite.config.tsを解決できずconfigロードで停止。`.out/plan-assignments-build.log`。権限拡張、設定変更、別経路の再試行はしていない。

新しい配布物は未生成、今回の変更を含むパッケージ/隔離Electron表示は未検証。jsdomでの表示確認のみ実施した。全回帰、全GUI、実provider通信は依頼範囲外で未実施。

既存distは4644f39由来の配布物のままで、以下のSHA256一致を確認。今回のUI修正が入った配布物と案内しない。既存インストール・oldfake HOME・ACL/trustedは変更していない。

- `dist/win-unpacked/XHarness.exe`: `0c6a9ee66f9803e5e5bd8e14ca0be67e3372a4db2ea158b533b90345176d7e79`
- `dist/win-unpacked/resources/app.asar`: `b2c21ba936fd59dd2f2ba2988267254bc3e41e8bd31ff60796e055dbf6fd1189`

ユーザーの「OK」により、今回のローカルコミット呼出だけauthor/committerをCodex <codex@local>とする承認を取得。Git永続設定を変更せず、この報告を含む担当表示修正5ファイルのみをコミット対象とする。push/mergeなし。配布版の実表示を確認するには通常ユーザー環境でのbuild/packageが残るが、この作業では権限問題を回避して実行しない。

## 利用者の通常PowerShellでの配布作成（この作業では未実行）

repositoryを作業場所にし、既存のpackage:dirを使う。出力先は既存distと分け、存在しない `.out/plan-assignments-dist` を指定する。実行直後の終了コードを保存する。

```powershell
Set-Location 'C:\Users\ahwri\Documents\Codex\2026-10-05\task\Xharness-connections'
.\scripts\pnpm.ps1 package:dir --config.directories.output=.out/plan-assignments-dist *> .out/manual-package-plan-assignments.log
$packageExitCode = $LASTEXITCODE
$packageExitCode | Set-Content -LiteralPath .out/manual-package-plan-assignments.exit.txt
$packageExitCode
```

exit 0を確認後、ログ末尾と `.out/plan-assignments-dist/win-unpacked/XHarness.exe` および `resources/app.asar` の新規生成を確認する。失敗時はログと終了コードを保存したまま停止する。インストーラー実行・既存アプリ上書き・モデル送信はこの手順に含めない。packageの正常終了だけで隔離GUI表示確認済みとは扱わない。
