# Codex 同梱CLIの自動追従

- 対象: `codex/loopflow-workflow-ui`、基準 `27262a3bea4ff0840604a23036a1534b5345c90d` 上の未コミット差分。
- 環境: Windows、Node 24.16.0。開発コマンドは Codex 同梱 PowerShell 7.6.5 と `scripts/pnpm.ps1`。製品の登録情報照会は Windows 標準 PowerShell を使う。
- 実AI通信・CLI起動・認証操作・インストール・ACL変更は行っていない。

## 実装

自動設定では Windows の `Get-AppxPackage -Name OpenAI.Codex` から現在ユーザーに登録されたパッケージを取得する。正確な名前・publisher ID・package full name・絶対パスを検証し、`app/resources/codex.exe` と同じ場所にある code-mode host、command runner、sandbox setup/service を参照する。cache のフォルダー名、mtime、ソート順から現用版を推測しない。0件・複数件・不明な発行元・未対応レイアウト・helper欠損では停止し、明示の実行パス指定を案内する。PATH の別CLIへは戻さない。

起動時と次のタスクの前に再取得する。作成済みAgentは同じ実行パスを保持し、タスク進行中は設定変更を拒否する。失敗したCLIでモデル要求を自動再送しない。

障害時には利用者がexeまたはフォルダーを指定できる。フォルダーは直下の `codex.exe` のみを指す。旧 `codexPath` は固定設定として保持し、ファイルが消えていても自動設定へ戻さない。「同梱版の自動追従に戻す」を明示操作した場合だけ変更する。UIには自動/固定、登録パッケージ、参照先、確認失敗を表示する。秘密情報の読み取り・表示は追加していない。

## 実機の読み取り確認

登録情報は `OpenAI.Codex_26.1002.7124.0_x64__2p2nqsd0c76g0`。登録場所の `app/resources/codex.exe` と、従来使用していたユーザーcacheの `bin/9691020b546a15b2/codex.exe` は、SHA256 `3553cd6e7df5a093d8cb8301cd8088a57e0971aba71ddbe0e67f7f44a15cdf68` で一致した。これはファイルの同一性の確認であり、今回の直接参照パスからのCLI実行成功を意味しない。

公式公開資料は app / CLI / app-server が同じCodex基盤を使うことを説明しているが、Windowsの内部配置を恒久契約として保証していない。内部配置の変更は明示エラーにする。参考: [Codex as a platform](https://developers.openai.com/blog/codex-as-a-platform)。

## 検証

- `codex-installation.test.ts` / `service.test.ts` / `OfficialWorkflowPanel.test.tsx` / `CodexRuntimeSettings.test.tsx`: 64件成功。その後追加した不正設定の保護・設定保存失敗の復元を含む対象5件も成功（他42件は名前フィルターで除外。5件中3件は前記と重複）。
- 型チェック、変更対象ESLint成功。
- 登録更新、曖昧な登録、発行元不一致、helper欠損、照会失敗、明示フォルダー、旧設定消失、自動への明示復帰、再起動、UI操作を模擬確認。
- 最初のテストで1件、接続確認より先に計画モデル未選択を拒否する期待と競合した。製品の入力検証を接続確認より前に戻し、接続検証用ケースには計画モデルを指定して成功。

## 未確認・制限

Store/AppX登録版のみ自動検出する。非Store・未対応レイアウトは明示指定が必要。登録済みresourcesからの実CLI起動、実更新後の追従、実画面での操作は未検証。Codexアプリが更新されるまで、XHarnessも同じ同梱CLIを使うため、上流修正が自動で先取りされるわけではない。固定版へ切り替える場合は公式配布物を同梱helper一式とともに配置する。
