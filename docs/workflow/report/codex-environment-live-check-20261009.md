> 過去の記録：移動元 `docs/codex-environment-live-check-20261009.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# Codex実行環境の実アプリ確認

2026-10-09、Windows、ブランチ `feature/native-workflow-boundary`、対象版・確認時HEAD `3627b89`。
背景: [環境修正の実アプリ検証記録](workflow-environment-fix-live-20261009.md)。仕様参照: SPEC.md §15。
実装担当はCodex gpt-6.1-sol、レビューはClaude claude-opus-5-5。本書作成時点ではレビュー未実施だったが、その後レビューまで完了した。軽微な表現の3指摘を受け、完了後に本書の説明を補足した。

作業場所 `D:/AIwork/Xharness` で以下を読み取り専用で各1回実行した。各項目を実行した公式コマンドitemはすべて終了コード0（PowerShellの版確認はシェル内の式評価）。

| 項目             | 実行コマンド                                                                                                                                            | 結果・実際の出力                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Node             | `node --version`                                                                                                                                        | 成功: `v24.16.0`                                                                                  |
| Git              | `git --version`                                                                                                                                         | 成功: `git version 2.54.0.windows.1`                                                              |
| PowerShell       | `$PSVersionTable.PSVersion.ToString()`                                                                                                                  | 成功: `7.6.5`（実行シェル自身で確認）                                                             |
| ファイルハッシュ | `pwsh -NoProfile -Command 'Get-FileHash -Algorithm SHA256 -LiteralPath docs/workflow-environment-fix-live-20261009.md \| Select-Object Algorithm,Hash'` | 成功: Algorithm `SHA256`、Hash `1225E01C1B83100CCFBB51EE26676581BDEBE1B9D848C86A40EB395187B8376B` |

変更前の `git status --short` は出力なし。変更はこの新規文書1件のみ。
確認した環境情報は上記の版番号に限り、実行ファイルの実体・配布形態は未確認。
PowerShellの版は実行シェル自身の値。PATHからのpwsh起動は、次のGet-FileHash項目で確認した。
失敗項目・再試行はなし。既存ファイル・ソース・設定・権限・資格情報は変更していない。
commit、インストール、作業場所外の探索、コマンドからのモデル・API通信は行っていない。
プロジェクトのテスト・ビルド・全回帰・配布更新は未実施。使用量・コストは未観測。
