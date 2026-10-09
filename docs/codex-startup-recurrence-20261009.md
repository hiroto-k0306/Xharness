# Codex実行準備失敗の再発と固定CLI指定

調査対象: インストール済みXHarnessのソース54af35eb73dfe1b3c7fc4dcccc7bf8071d9b52d5、feature/native-workflow-boundary。Windows、2026-10-09。根拠は利用者の保存workflow、公式sandboxログ、実アプリの接続設定とCLIの `--version`。現行仕様はSPEC §15の起動失敗時停止・CLI固定指定。

## 確認した原因

質問判別とClaudeの計画は成功。Codex gpt-6.1-solの実装は10,963 msでfailed。操作承認はallowedで、commandExecutionがexitCode=-1、durationMs=0、source=unifiedExecStartupだった。公開結果の本文は `Failed to create unified exec process: helper_unknown_error: setup refresh had errors`。許可の拒否やテストの不合格とは異なる。

公式sandboxログの同時刻（2026-10-08 16:26:56 UTC / 10月9日01:26:56 JST）には、cua_nodeのnode_repl.exeに対するruntime read/execute validationが、root-only ACL targetを開く際の共有違反 `os error 32` で失敗した記録がある。setup_error.jsonも同じsetup refresh失敗を記録していた。ログから特定のロック保持プロセスまで確認したとは扱わない。

現在のアプリは「同梱版へ自動追従」を表示。connection.jsonは存在せず、config.yamlのauth.codexCliPathも未設定だった。登録済みCodexアプリはOpenAI.Codex_26.1002.7124.0_x64で、同梱CLIの `--version` は0.162.0-alpha.2。以前の共有違反調査時と同じ版だった。固定指定が消えた時点・原因は未確認。直前の再インストールは設定・履歴948ファイルのハッシュ一致を確認しており、今回の証跡だけでインストーラーが設定を消したとは判断しない。

以前導入した0.162.0-alpha.20が残っていることと、その `--version` を確認した。以前の併用実通信成功は docs/codex-prerelease-live-20261008.md にあり、今回の実通信成功として再利用しない。

## 対応

承認済みの障害時CLI固定指定方針に沿って、実アプリの公式Codex実行パス欄に `D:/AIwork/XHarness-runtimes/codex/0.162.0-alpha.20/bin` を入力し、接続設定を保存した。画面の「指定版を固定」と参照先codex.exe、connection.jsonのcodexMode=fixedと同じパスを確認。アプリを起動したまま残した。

ソースコード・sandbox方式・ACL・資格情報は変更していない。同梱版へ自動追従する設定は固定指定中だけ停止する。OS権限緩和、Codexの強制終了、資格情報抽出・コピー、再インストール、失敗作業の自動再送は行わない。

今回の新規モデル通信・認証操作は0回。CLIの版確認と設定保存のみで、修正後の実作業成功は未確認。ビルド・全回帰はソース変更がないため再実行していない。固定指定の永続保存はファイルで確認したが、再起動は今回行っていない。

公式資料も確認: [設定リファレンス](https://learn.chatgpt.com/docs/config-file/config-reference)。公開のwindows.sandbox設定があることと、今回の旧helperの共有違反は別であり、sandboxを切り替えて回避する対応は採用していない。
