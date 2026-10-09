> 過去の記録：移動元 `docs/codex-command-failure-misclassification-20261009.md`、整理基準 `0e5fa40da0d8bc39b71fb36b83cce82a8fe18087`。本文の対象時点・環境の結果です。現在の契約は[全体仕様](../../Spec.md)から参照してください。この整理では試験を再実行していません。

# CLI固定後のコマンド失敗の誤分類

対象ソース: f8b9cbf1bded66788de983fcd8f1ae091500de6a、インストール済みアプリのソース54af35e。Windows、2026-10-09。現行仕様SPEC §15。利用者が実行した保存workflowと公式sandboxログを読むだけの調査で、新しいモデル通信・認証操作は行っていない。

## 今回確認した事実

- 保存workflow `13d0d3da-48e6-432d-a1f4-b8c42437ad86` のCodex実装では、4件のコマンド承認がallowed。先頭3件は終了0で完了し、最後は終了1・2,891 msで失敗した。全4件のsourceが `unifiedExecStartup` であり、この値だけでは起動失敗と判定できない。
- 最後の公開結果はPowerShellの `CommandNotFoundException` / `ObjectNotFound: (node:String)`。`node -e` の実行でnodeを解決できなかった。Nodeによるファイル処理は実行されていない。日本語出力には文字化けもあるため、翻訳で失敗本文を補完しない。
- 同時刻07:17台の公式sandboxログはalpha.20フォルダーのsetup/command-runnerを参照。setup refreshは `errors=[]`。connection.jsonもalpha.20の固定指定を維持している。今回の記録に前回の共有違反を再帰属しない。
- ホストの `C:/Program Files/nodejs/node.exe` は存在し、直接の `--version` はv24.16.0。Machine PATHにも同フォルダーがある。ただし、起動済みアプリ・App Server・sandbox内の実際のPATHはまだ観測していない。ホストで見つかることをsandbox内で見つかる証明にしない。

## 問題と修正案

`codex.ts` はcommandExecutionのfailedとsourceだけで即座にphaseをabortするため、正常に起動したコマンドの非ゼロ終了を準備失敗へ誤分類する。これによりCodexがエラーを受け取って代替手段を検討する前にXHarnessが停止する。前回のCLI固定指定は反映済みで、今回の停止はその設定が無効だったためではない。

起動失敗を明示する公開結果も照合し、それ以外の通常コマンド失敗は診断に残して公式エージェントへ返す。通常失敗を成功へ読み替えず、最終turn・成果・検証結果でphaseの成否を判断する。共有違反の特定は引き続き公式sandboxログの根拠が必要。判定変更はSPEC §15の現行停止条件を変えるため、実装前に利用者へ確認し、「この方針で修正する」の承認を受けて実装・SPEC更新した。

PATH対策は未適用。無差別な環境継承、秘密値の伝搬、sandbox緩和、ACL変更、資格情報コピーは行わない。公式の環境設定は [構成リファレンス](https://learn.chatgpt.com/docs/config-file/config-reference) のshell_environment_policyを参照。起動済みアプリで未検証のPATHを推測で上書きしない。

## 実装とオフライン検証

commandExecutionのfailed・source・公開結果先頭の `Failed to create unified exec process:` を併せて照合する。本文未提供なら同じitemのoutputDelta（メモリ上限8,000文字）を使う。診断本文の保存条件は変えない。item通知と最終turnの重複排除、別threadの除外、取消・quota停止の優先を維持した。

対象は上記f8b9cbfからの本報告と同一コミット内の差分。scripts/pnpm.ps1を使用、Node v22.23.3、pwsh 7.6.5の実体はCodex依存ランタイムの `dependencies/native/powershell/pwsh.exe`。Store版pwshで検証したとは扱わない。ホストNode v24.16.0は存在・版確認だけで、今回のテスト実行版ではない。

- codex.test.ts / public-events.test.ts / diagnostics.test.ts: 最終82件成功。今回7件追加。node未検出、テスト失敗、未知・欠測本文、文中にエラー文を含む通常出力、deltaだけの明示的起動失敗、通常コマンド失敗後の最終turn失敗を確認した。
- typecheck、変更したTypeScript 2ファイルのESLint、変更4ファイルのPrettier check、通常build、git diff --check: 成功。
- 初回はdelta本文を診断設定false時に取り込まない既存条件で1テスト失敗。保存条件を変えず、メモリ内の照合だけを可能にして修正。初回typecheckは追加テストの任意要素アクセスで失敗し、optional chaining修正後に成功。失敗を最終結果へ混ぜて隠さない。

全回帰・headless build・GUI・配布物作成・インストール更新は未実施。Node未検出の環境差と分類修正後の実通信も未確認。インストール済みアプリにはまだ今回のコード修正が入っていない。過去のalpha.20実通信成功を今回の作業完了とは扱わない。
